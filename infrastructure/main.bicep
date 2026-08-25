targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentName string
param apiImage string
param containerRegistryLoginServer string
param entraTenantId string
param entraApiClientId string
param entraIssuer string
param entraJwksUrl string
param postgresAdministratorLogin string
@secure()
param postgresAdministratorPassword string

var namePrefix = toLower('compdash${environmentName}')

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-kv'
  location: location
  properties: {
    tenantId: entraTenantId
    sku: { family: 'A'; name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${namePrefix}-pg'
  location: location
  sku: { name: 'Standard_D2ds_v5'; tier: 'GeneralPurpose' }
  properties: {
    administratorLogin: postgresAdministratorLogin
    administratorLoginPassword: postgresAdministratorPassword
    version: '16'
    storage: { storageSizeGB: 128; autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7; geoRedundantBackup: 'Disabled' }
    network: { publicNetworkAccess: 'Disabled' }
  }
}

resource redis 'Microsoft.Cache/redis@2024-03-01' = {
  name: '${namePrefix}-redis'
  location: location
  properties: {
    sku: { name: 'Basic'; family: 'C'; capacity: 0 }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Disabled'
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-cae'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logAnalytics.properties.customerId; sharedKey: logAnalytics.listKeys().primarySharedKey }
    }
  }
}

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-api'
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true; targetPort: 8000; transport: 'http' }
      registries: [{ server: containerRegistryLoginServer; identity: 'system' }]
    }
    template: {
      containers: [{
        name: 'ask-api'
        image: apiImage
        resources: { cpu: json('0.5'); memory: '1Gi' }
        env: [
          { name: 'COMPDASH_ASK_ENVIRONMENT'; value: environmentName }
          { name: 'COMPDASH_ASK_ENTRA_TENANT_ID'; value: entraTenantId }
          { name: 'COMPDASH_ASK_ENTRA_CLIENT_ID'; value: entraApiClientId }
          { name: 'COMPDASH_ASK_ENTRA_ISSUER'; value: entraIssuer }
          { name: 'COMPDASH_ASK_ENTRA_JWKS_URL'; value: entraJwksUrl }
          { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'; value: appInsights.properties.ConnectionString }
        ]
      }]
      scale: { minReplicas: 1; maxReplicas: 5 }
    }
  }
}

output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output keyVaultName string = keyVault.name
output postgresServerName string = postgres.name
output redisName string = redis.name
