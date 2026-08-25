// Structured display for analyze_site tool results.
// Shows fleet profile, peer sites, production metrics, clipping, benchmarking,
// and anomalies as visual cards — BEFORE the LLM narrative.

import { useState } from 'react'
import { AlertTriangle, CheckCircle, MapPin, TrendingUp, TrendingDown, Minus, Zap, Users, Activity, Wrench, Thermometer, Battery, Radio, Sun, Eye, EyeOff } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface SiteAnalysisResultProps {
  row: Record<string, unknown>
}

function n(v: unknown, decimals = 1): string {
  const num = Number(v)
  return Number.isFinite(num) ? num.toFixed(decimals) : '—'
}

function s(v: unknown): string {
  return v != null && String(v).trim() !== '' ? String(v) : '—'
}

function TrendBadge({ trend }: { trend: string }) {
  if (trend === 'increasing') return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><TrendingUp className="mr-1 h-3 w-3" />Increasing</Badge>
  if (trend === 'decreasing') return <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"><TrendingDown className="mr-1 h-3 w-3" />Decreasing</Badge>
  if (trend === 'stable') return <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"><Minus className="mr-1 h-3 w-3" />Stable</Badge>
  if (trend === 'highly_variable') return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"><Activity className="mr-1 h-3 w-3" />Highly Variable</Badge>
  return <Badge variant="secondary">{trend}</Badge>
}

function ClippingBadge({ classification }: { classification: string }) {
  if (classification === 'none') return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"><CheckCircle className="mr-1 h-3 w-3" />None</Badge>
  if (classification === 'minor') return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"><Zap className="mr-1 h-3 w-3" />Minor</Badge>
  if (classification === 'moderate') return <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200"><Zap className="mr-1 h-3 w-3" />Moderate</Badge>
  if (classification === 'significant') return <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"><AlertTriangle className="mr-1 h-3 w-3" />Significant</Badge>
  return <Badge variant="outline">{classification}</Badge>
}

export function SiteAnalysisResult({ row }: SiteAnalysisResultProps) {
  const [showProdMicro, setShowProdMicro] = useState(false)
  const [showClipMicro, setShowClipMicro] = useState(false)
  const [showEnv, setShowEnv] = useState(true)
  const [showRma, setShowRma] = useState(true)

  const fleet = row['fleet_summary'] as Record<string, unknown> | null
  const tov = row['telemetry_overview'] as Record<string, unknown> | undefined
  const prod = row['production'] as Record<string, unknown> | undefined
  const clipping = row['clipping'] as Record<string, unknown> | undefined
  const bench = row['peer_benchmarking'] as Record<string, unknown> | undefined
  const anom = row['anomaly_summary'] as Record<string, unknown> | undefined
  const peers = row['comparable_sites'] as Record<string, unknown>[] | undefined
  const clippingReasons = row['clipping_reasons'] as Record<string, unknown> | undefined
  const mismatch = row['inverter_mismatch'] as Record<string, unknown> | undefined
  const acPower = row['microinverter_ac_power'] as Record<string, unknown>[] | undefined
  const env = row['microinverter_environment'] as Record<string, unknown>[] | undefined
  const rma = row['rma_summary'] as Record<string, unknown> | undefined
  const siteRma = row['site_rma'] as Record<string, unknown> | undefined
  const hasTelemetry = Boolean(row['telemetry_available'])

  const grid = fleet?.['grid_profile'] as Record<string, unknown> | undefined

  return (
    <div className="space-y-3">

      {/* Fleet profile */}
      {fleet && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <MapPin className="h-4 w-4 text-primary" />
              Site {s(row['site_id'])} — Fleet Profile
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 md:grid-cols-4">
              <Kv k="Location" v={[s(fleet['city']), s(fleet['state']), s(fleet['country'])].filter(v => v !== '—').join(', ')} />
              <Kv k="Inverter" v={s(fleet['product_type'])} />
              <Kv k="Model" v={s(fleet['model_name'])} />
              <Kv k="Module" v={`${s(fleet['pv_module_make'])} ${s(fleet['pv_module_model'])}`} />
              <Kv k="Wafer" v={s(fleet['module_wafer'])} />
              <Kv k="STC Rating" v={fleet['stc_rating_w'] != null ? `${n(fleet['stc_rating_w'], 0)} W` : '—'} />
              <Kv k="DC/AC" v={s(fleet['dc_ac_ratio'])} />
              <Kv k="Units" v={s(fleet['unit_count'])} />
              <Kv k="MWdc" v={fleet['stc_mwdc'] != null ? `${n(fleet['stc_mwdc'], 3)}` : '—'} />
              <Kv k="Irradiance" v={fleet['irradiance_kwh_m2_month'] != null ? `${n(fleet['irradiance_kwh_m2_month'], 1)} kWh/m²/day` : '—'} />
              <Kv k="Voc" v={fleet['voc'] != null ? `${n(fleet['voc'], 1)} V` : '—'} />
              <Kv k="Isc" v={fleet['isc'] != null ? `${n(fleet['isc'], 2)} A` : '—'} />
              <Kv k="First Install Quarter" v={s(fleet['quarter_first_interval'])} />
              <Kv k="Region" v={s(fleet['region'])} />
              {grid && (
                <Kv
                  k="Grid Profile"
                  v={`${n(grid['voltage_v'], 0)}V / ${n(grid['frequency_hz'], 0)}Hz · ${s(grid['phase'])}`}
                />
              )}
              {Boolean(grid?.['note']) && (
                <div className="col-span-full text-[10px] text-muted-foreground">
                  {s(grid?.['note'])} {fleet['circuit_phase'] ? `· Phase: ${s(fleet['circuit_phase'])}` : ''} {fleet['production_eim_config'] ? `· EIM: ${s(fleet['production_eim_config'])}` : ''}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {peers != null && peers.length > 0 ? (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Users className="h-4 w-4 text-primary" />
              Comparable Sites ({peers.length}) — v2 Similarity Score
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {peers.map((p, i) => <PeerScoreCard key={i} p={p} />)}
          </CardContent>
        </Card>
      ) : null}

      {!hasTelemetry && Boolean(row['telemetry_note']) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{String(row['telemetry_note'])}</p>
        </div>
      )}

      {hasTelemetry && (
        <>
          {/* Production metrics */}
          {(tov || prod) && (
            <Card>
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  Production Analysis
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {prod && <TrendBadge trend={String(prod['trend'] ?? 'unknown')} />}
                  {prod?.['valid_days'] != null && <span className="text-xs text-muted-foreground">{s(prod['valid_days'])} valid days</span>}
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 md:grid-cols-4">
                  {tov && <>
                    <Kv k="Microinverters" v={s(tov['microinverter_count'])} />
                    <Kv k="Data coverage" v={`${s(tov['first_reading'])} → ${s(tov['last_reading'])}`} />
                    <Kv k="Total readings" v={s(tov['total_readings'])} />
                  </>}
                  {prod && <>
                    <Kv k="Avg daily" v={`${n(prod['avg_daily_kwh'])} kWh`} />
                    <Kv k="Median daily" v={`${n(prod['median_daily_kwh'])} kWh`} />
                    <Kv k="Min daily" v={`${n(prod['min_daily_kwh'])} kWh`} />
                    <Kv k="Max daily" v={`${n(prod['max_daily_kwh'])} kWh`} />
                  </>}
                </div>

                {acPower && acPower.length > 0 && (
                  <div className="mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowProdMicro((v) => !v)}
                      className="text-xs"
                    >
                      {showProdMicro ? <EyeOff className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3 w-3" />}
                      {showProdMicro ? 'Hide Microinverter Detail' : "See Microinverter's Detail"}
                    </Button>
                    {showProdMicro && (
                      <div className="mt-2 overflow-x-auto rounded border bg-muted/20 p-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-[10px] uppercase text-muted-foreground">
                              <th className="pb-1">Serial</th>
                              <th className="pb-1">Model</th>
                              <th className="pb-1 text-right">Max W</th>
                              <th className="pb-1 text-right">Median W</th>
                              <th className="pb-1 text-right">Avg W</th>
                              <th className="pb-1 text-right">Readings</th>
                            </tr>
                          </thead>
                          <tbody>
                            {acPower.map((inv, i) => (
                              <tr key={i} className="border-t border-border/40">
                                <td className="py-1 font-mono">{s(inv['serial_number'])}</td>
                                <td className="py-1 text-muted-foreground">{s(inv['sku_name'])}</td>
                                <td className="py-1 text-right">{n(inv['max_ac_power_w'], 0)}</td>
                                <td className="py-1 text-right">{n(inv['median_ac_power_w'], 0)}</td>
                                <td className="py-1 text-right">{n(inv['avg_ac_power_w'], 0)}</td>
                                <td className="py-1 text-right">{s(inv['reading_count'])}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Clipping + Peer benchmarking side by side */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {clipping && (
              <Card>
                <CardHeader className="pb-2 pt-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <Zap className="h-4 w-4 text-primary" />
                    Clipping
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="mb-2">
                    <ClippingBadge classification={String(clipping['classification'] ?? 'unknown')} />
                  </div>
                  <div className="space-y-1 text-sm">
                    <Kv k="Power events" v={s(clipping['power_event_count'])} />
                    <Kv k="Current events" v={s(clipping['current_event_count'])} />
                    <Kv k="Affected days" v={s(clipping['affected_days'])} />
                  </div>

                  {Array.isArray(clipping['events']) && (clipping['events'] as Record<string, unknown>[]).length > 0 && (
                    <div className="mt-3 rounded border bg-muted/20 p-2">
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Top Events (date · start · end · duration)</p>
                      <div className="space-y-1">
                        {(clipping['events'] as Record<string, unknown>[]).slice(0, 6).map((e, i) => (
                          <div key={i} className="flex flex-wrap gap-x-3 text-xs">
                            <span className="font-mono text-muted-foreground">{s(e['date'])}</span>
                            <span>{n(e['start_hour'], 0)}:00 → {n(e['end_hour'], 0)}:00</span>
                            <span className="font-semibold">{n(e['duration_hours'], 1)} h</span>
                            <span className="text-muted-foreground">{s(e['serial_number'])}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {Array.isArray(clipping['events_by_serial']) && (clipping['events_by_serial'] as Record<string, unknown>[]).length > 0 && (
                    <div className="mt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowClipMicro((v) => !v)}
                        className="text-xs"
                      >
                        {showClipMicro ? <EyeOff className="mr-1 h-3 w-3" /> : <Eye className="mr-1 h-3 w-3" />}
                        {showClipMicro ? 'Hide Microinverter Detail' : "See Microinverter's Detail"}
                      </Button>
                      {showClipMicro && (
                        <div className="mt-2 space-y-2">
                          {(clipping['events_by_serial'] as Record<string, unknown>[]).map((g, i) => {
                            const power = (g['power_events'] as Record<string, unknown>[] | undefined) ?? []
                            const current = (g['current_events'] as Record<string, unknown>[] | undefined) ?? []
                            return (
                              <div key={i} className="rounded border bg-muted/30 p-2 text-xs">
                                <div className="mb-1 font-mono font-semibold">{s(g['serial'])} {g['sku'] ? `(${s(g['sku'])})` : ''}</div>
                                {power.length > 0 && (
                                  <div className="mb-1">
                                    <span className="text-[10px] font-semibold uppercase text-muted-foreground">Power clipping</span>
                                    <div className="space-y-0.5">
                                      {power.slice(0, 5).map((e, j) => (
                                        <div key={j} className="flex gap-2 text-muted-foreground">
                                          <span>{s(e['date'])}</span>
                                          <span>{n(e['start_hour'], 0)}:00–{n(e['end_hour'], 0)}:00</span>
                                          <span>{n(e['duration_hours'], 1)} h</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {current.length > 0 && (
                                  <div>
                                    <span className="text-[10px] font-semibold uppercase text-muted-foreground">Current clipping</span>
                                    <div className="space-y-0.5">
                                      {current.slice(0, 5).map((e, j) => (
                                        <div key={j} className="flex gap-2 text-muted-foreground">
                                          <span>{s(e['date'])}</span>
                                          <span>{n(e['start_hour'], 0)}:00–{n(e['end_hour'], 0)}:00</span>
                                          <span>{n(e['duration_hours'], 1)} h</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Clipping reason breakdown */}
            {clippingReasons && (
              <Card className="border-orange-200 dark:border-orange-800">
                <CardHeader className="pb-2 pt-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold text-orange-700 dark:text-orange-300">
                    <Zap className="h-4 w-4" />
                    Clipping Diagnosis
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-xs">
                  {(() => {
                    const cur = clippingReasons['current_clipping'] as Record<string, unknown> | undefined
                    const pwr = clippingReasons['power_clipping'] as Record<string, unknown> | undefined
                    return (
                      <>
                        {cur && (
                          <div>
                            <p className="mb-1 font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">DC Current Clipping</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                              <Kv k="Characteristic" v={`${n(cur['characteristic_current_a'], 2)} A`} />
                              <Kv k="Range" v={`${n(cur['min_clipped_a'], 2)} – ${n(cur['max_clipped_a'], 2)} A`} />
                              <Kv k="Variation" v={`${n(cur['variation_a'], 2)} A`} />
                              <Kv k="Consistent" v={cur['is_consistent'] ? 'Yes' : 'No ⚠'} />
                            </div>
                            {cur['consistency_flag'] != null && (
                              <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                                {String(cur['consistency_flag'])}
                              </p>
                            )}
                            {Array.isArray(cur['per_day']) && cur['per_day'].length > 0 && (
                              <div className="mt-1.5 space-y-0.5">
                                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Per Day</p>
                                {(cur['per_day'] as Array<Record<string, unknown>>).slice(0, 7).map((d, i) => (
                                  <div key={i} className="flex gap-4">
                                    <span className="font-mono text-muted-foreground">{s(d['date'])}</span>
                                    <span className="font-semibold">{n(d['avg_current_a'], 2)} A</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {pwr && (
                          <div>
                            <p className="mb-1 font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">AC Power Clipping</p>
                            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                              <Kv k="Characteristic" v={`${n(pwr['characteristic_power_w'], 0)} W`} />
                              <Kv k="Rated AC" v={pwr['rated_ac_capacity_w'] != null ? `${n(pwr['rated_ac_capacity_w'], 0)} W` : 'Unknown'} />
                              <Kv k="% of Rated" v={pwr['pct_of_rated'] != null ? `${n(pwr['pct_of_rated'], 1)} %` : '—'} />
                              <Kv k="At Rated?" v={pwr['is_at_rated_capacity'] ? 'Yes ✓' : 'No ⚠'} />
                            </div>
                            {pwr['assessment'] != null && (
                              <p className={`mt-1 rounded px-2 py-1 ${
                                pwr['is_at_rated_capacity']
                                  ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300'
                                  : 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
                              }`}>
                                {String(pwr['assessment'])}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </CardContent>
              </Card>
            )}

            {bench && (
              <Card>
                <CardHeader className="pb-2 pt-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                    <Activity className="h-4 w-4 text-primary" />
                    Peer Benchmarking
                    {!!bench['low_confidence'] && <Badge variant="secondary" className="ml-1 text-[10px]">Low confidence</Badge>}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1 text-sm">
                    <Kv k="Target avg/day" v={`${n(bench['target_avg_daily_kwh'])} kWh`} />
                    <Kv k="Peer median/day" v={`${n(bench['peer_median_daily_kwh'])} kWh`} />
                    <Kv k="Deviation" v={bench['deviation_pct'] != null ? `${Number(bench['deviation_pct']) >= 0 ? '+' : ''}${n(bench['deviation_pct'])}%` : '—'} />
                    <Kv k="Peers used" v={s(bench['peers_analyzed'])} />
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Anomaly summary */}
          {anom && (Number(anom['alerts'] ?? 0) > 0 || Number(anom['warnings'] ?? 0) > 0) && (
            <Card className="border-amber-200 dark:border-amber-800">
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4" />
                  Anomaly Summary — {s(anom['alerts'])} alert(s), {s(anom['warnings'])} warning(s)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(row['anomaly_alerts'] as Record<string, unknown>[] | undefined)?.slice(0, 5).map((a, i) => (
                  <div key={i} className="mb-1 text-xs">
                    <span className="font-mono font-semibold text-red-600 dark:text-red-400">{s(a['serial_number'])}</span>
                    {' '}<span className="text-muted-foreground">z={n(a['z_score'], 2)} | {n(a['energy_kwh'])} kWh vs mean {n(a['site_mean_kwh'])} kWh</span>
                  </div>
                ))}
                {(row['anomaly_warnings'] as Record<string, unknown>[] | undefined)?.slice(0, 3).map((a, i) => (
                  <div key={i} className="mb-1 text-xs">
                    <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">{s(a['serial_number'])}</span>
                    {' '}<span className="text-muted-foreground">z={n(a['z_score'], 2)} | {n(a['energy_kwh'])} kWh vs mean {n(a['site_mean_kwh'])} kWh</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Per-inverter mismatch */}
          {mismatch && !!mismatch['has_mismatch'] && (
            <Card className="border-red-200 dark:border-red-800">
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
                  <Wrench className="h-4 w-4" />
                  Inverter Mismatch — {s(mismatch['flagged_count'])} of {s(mismatch['total_analyzed'])} flagged (&gt;20% deviation)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <div className="mb-2 grid grid-cols-3 gap-x-4 text-xs text-muted-foreground">
                  <span>Site median AC: <strong className="text-foreground">{n(mismatch['site_median_power_w'], 0)} W</strong></span>
                  <span>Median DC I: <strong className="text-foreground">{n(mismatch['site_median_current_a'], 2)} A</strong></span>
                  <span>Median DC V: <strong className="text-foreground">{n(mismatch['site_median_voltage_v'], 1)} V</strong></span>
                </div>
                {(mismatch['flagged_inverters'] as Record<string, unknown>[] | undefined)?.map((inv, i) => (
                  <div key={i} className="rounded border border-red-100 bg-red-50 px-2 py-1 text-xs dark:border-red-900 dark:bg-red-950">
                    <span className="font-mono font-semibold text-red-700 dark:text-red-300">{s(inv['serial_number'])}</span>
                    {inv['sku_name'] != null && <span className="ml-1 text-muted-foreground">({s(inv['sku_name'])})</span>}
                    <span className="ml-2">
                      AC {n(inv['avg_ac_power_w'], 0)} W
                      {inv['power_dev_pct'] != null && <span className="ml-1 font-semibold text-red-600">(+{n(inv['power_dev_pct'], 1)}%)</span>}
                    </span>
                    <span className="ml-2">
                      DC I {n(inv['avg_dc_current_a'], 2)} A
                      {inv['current_dev_pct'] != null && <span className="ml-1 font-semibold text-red-600">(+{n(inv['current_dev_pct'], 1)}%)</span>}
                    </span>
                    <span className="ml-2">
                      DC V {n(inv['avg_dc_voltage_v'], 1)} V
                      {inv['voltage_dev_pct'] != null && <span className="ml-1 font-semibold text-red-600">(+{n(inv['voltage_dev_pct'], 1)}%)</span>}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* AC voltage / frequency / temperature per microinverter */}
          {env && env.length > 0 && (
            <Card>
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold">
                  <Thermometer className="h-4 w-4 text-primary" />
                  Microinverter Environment
                  <Button variant="ghost" size="sm" onClick={() => setShowEnv((v) => !v)} className="ml-auto h-6 px-2 text-xs">
                    {showEnv ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </Button>
                </CardTitle>
              </CardHeader>
              {showEnv && (
                <CardContent>
                  <div className="overflow-x-auto rounded border bg-muted/20 p-2">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] uppercase text-muted-foreground">
                          <th className="pb-1">Serial</th>
                          <th className="pb-1">Model</th>
                          <th className="pb-1 text-right">AC V avg</th>
                          <th className="pb-1 text-right">AC V range</th>
                          <th className="pb-1 text-right">Freq avg</th>
                          <th className="pb-1 text-right">Freq range</th>
                          <th className="pb-1 text-right">Temp avg</th>
                          <th className="pb-1 text-right">Temp range</th>
                        </tr>
                      </thead>
                      <tbody>
                        {env.map((inv, i) => (
                          <tr key={i} className="border-t border-border/40">
                            <td className="py-1 font-mono">{s(inv['serial_number'])}</td>
                            <td className="py-1 text-muted-foreground">{s(inv['sku_name'])}</td>
                            <td className="py-1 text-right">{n(inv['avg_ac_voltage_v'], 1)} V</td>
                            <td className="py-1 text-right">{n(inv['min_ac_voltage_v'], 1)}–{n(inv['max_ac_voltage_v'], 1)}</td>
                            <td className="py-1 text-right">{n(inv['avg_ac_frequency_hz'], 2)} Hz</td>
                            <td className="py-1 text-right">{n(inv['min_ac_frequency_hz'], 2)}–{n(inv['max_ac_frequency_hz'], 2)}</td>
                            <td className="py-1 text-right">{n(inv['avg_temp_c'], 1)} °C</td>
                            <td className="py-1 text-right">{n(inv['min_temp_c'], 1)}–{n(inv['max_temp_c'], 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              )}
            </Card>
          )}

          {/* RMA / nearby 10km grid quality */}
          {rma && (
            <Card className="border-blue-200 dark:border-blue-800">
              <CardHeader className="pb-2 pt-3">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-blue-700 dark:text-blue-300">
                  <Radio className="h-4 w-4" />
                  Nearby Sites & RMA — 10 km Radius
                  <Button variant="ghost" size="sm" onClick={() => setShowRma((v) => !v)} className="ml-auto h-6 px-2 text-xs">
                    {showRma ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </Button>
                </CardTitle>
              </CardHeader>
              {showRma && (
                <CardContent>
                  {rma['note'] ? (
                    <p className="text-sm text-muted-foreground">{s(rma['note'])}</p>
                  ) : (
                    <>
                      <div className="mb-2 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                        <Kv k="RMA for this site" v={siteRma?.['rma_available'] ? s(siteRma['rma_count']) : 'No RMA data loaded'} />
                        <Kv k="Sites within 10 km" v={s(rma['nearby_site_count'])} />
                        <Kv k="RMA total nearby" v={rma['rma_available'] ? s(rma['rma_total_nearby']) : 'No RMA data loaded'} />
                      </div>
                      {Boolean(rma['rma_note']) && (
                        <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">{s(rma['rma_note'])}</p>
                      )}
                      {Array.isArray(rma['nearby_sites']) && (rma['nearby_sites'] as Record<string, unknown>[]).length > 0 && (
                        <div className="mt-2 space-y-1">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Closest nearby sites</p>
                          {(rma['nearby_sites'] as Record<string, unknown>[]).map((ns, i) => (
                            <div key={i} className="flex gap-3 text-xs">
                              <span className="font-mono">{s(ns['site_id'])}</span>
                              <span className="text-muted-foreground">{n(ns['distance_km'], 1)} km</span>
                              <span className="text-muted-foreground">{s(ns['location'])}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  )
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{k}</span>
      <span className="truncate font-medium">{v}</span>
    </div>
  )
}

// ─── Score pill ────────────────────────────────────────────────────────────────

function ScorePill({ score }: { score: number }) {
  const colour =
    score >= 8 ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
    : score >= 6 ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100'
    : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${colour}`}>
      {score.toFixed(2)} / 10
    </span>
  )
}

// ─── Mini score bar ────────────────────────────────────────────────────────────

function ScoreBar({ label, value, max }: { label: string; value: number | null; max: number }) {
  const pct = value != null ? Math.min(100, (value / max) * 100) : null
  return (
    <div className="flex items-center gap-2 text-[10px]">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-muted">
        {pct != null
          ? <div className="h-full rounded-full bg-primary/70 transition-all" style={{ width: `${pct}%` }} />
          : <div className="h-full rounded-full bg-muted-foreground/20" style={{ width: '100%' }} />}
      </div>
      <span className="w-12 text-right tabular-nums text-muted-foreground">
        {value != null ? `${value.toFixed(2)} / ${max}` : 'n/a'}
      </span>
    </div>
  )
}

// ─── Per-peer card for site analysis ─────────────────────────────────────────

function PeerScoreCard({ p }: { p: Record<string, unknown> }) {
  const scores = p['scores'] as Record<string, number | null> | undefined
  const totalScore = Number(p['total_score'] ?? 0)
  const coverage = Number(p['coverage'] ?? 0)

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-primary">{s(p['site_id'])}</span>
          <span className="text-xs text-muted-foreground">{s(p['location'])}</span>
          {p['distance_km'] != null && Number(p['distance_km']) >= 0
            && <span className="text-xs text-muted-foreground">{n(p['distance_km'], 1)} km</span>}
        </div>
        <div className="flex items-center gap-2">
          <ScorePill score={totalScore} />
          <Badge variant="secondary" className="text-[10px]">{coverage}% data</Badge>
          {p['telemetry_available'] != null && (
            p['telemetry_available']
              ? <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 text-[10px] px-1">Telemetry ✓</Badge>
              : <Badge variant="secondary" className="text-[10px] px-1">No telemetry</Badge>
          )}
        </div>
      </div>

      {scores && (
        <div className="mt-2 space-y-1">
          <ScoreBar label="Geography"  value={scores['geography']    ?? null} max={3.0} />
          <ScoreBar label="Power"      value={scores['module_power'] ?? null} max={2.0} />
          <ScoreBar label="Micro"      value={scores['microinverter']?? null} max={2.5} />
          <ScoreBar label="Wafer"      value={scores['wafer']        ?? null} max={2.0} />
          <ScoreBar label="Irradiance" value={scores['irradiance']   ?? null} max={0.5} />
        </div>
      )}

      {/* Module section */}
      <div className="mt-2 border-t border-border/40 pt-2">
        {p['has_module_info']
          ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Module</span>
              {p['pv_module_make'] != null && (
                <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                  {s(p['pv_module_make'])}
                </span>
              )}
              {p['pv_module_model'] != null && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {s(p['pv_module_model'])}
                </span>
              )}
              {p['stc_rating2'] != null && (
                <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-800 dark:bg-green-900 dark:text-green-200">
                  {n(p['stc_rating2'], 0)} W
                </span>
              )}
              {p['module_wafer'] != null && (
                <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                  {s(p['module_wafer'])}
                </span>
              )}
            </div>
          )
          : (
            <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
              ⚠ No module data
            </span>
          )
        }
      </div>

      {/* Secondary info row */}
      <div className="mt-1.5 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        {p['model_name'] != null && <span>Inverter: <strong>{s(p['model_name'])}</strong></span>}
        {p['irr_ann_kwh_m2_month'] != null && <span>Irr: <strong>{n(p['irr_ann_kwh_m2_month'], 1)} kWh/m²/day</strong></span>}
        {p['unit_count'] != null && <span>Units: <strong>{s(p['unit_count'])}</strong></span>}
      </div>
    </div>
  )
}

// ─── Microinverter analysis result renderer ───────────────────────────────────

interface MicroinverterAnalysisResultProps {
  row: Record<string, unknown>
}

export function MicroinverterAnalysisResult({ row }: MicroinverterAnalysisResultProps) {
  const overview = row['overview'] as Record<string, unknown> | undefined
  const fleet = row['fleet_summary'] as Record<string, unknown> | undefined
  const acPower = row['ac_power'] as Record<string, unknown> | undefined
  const environment = row['environment'] as Record<string, unknown> | undefined
  const daily = row['daily_production'] as Record<string, unknown> | undefined
  const clipping = row['clipping'] as Record<string, unknown> | undefined

  return (
    <div className="space-y-3">
      {fleet && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <MapPin className="h-4 w-4 text-primary" />
              Microinverter {s(row['serial_number'])} — Site {s(fleet['site_id'])}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 md:grid-cols-4">
              <Kv k="Site" v={s(fleet['site_id'])} />
              <Kv k="Location" v={[s(fleet['city']), s(fleet['state']), s(fleet['country'])].filter(v => v !== '—').join(', ')} />
              <Kv k="Model" v={s(fleet['model_name'])} />
              <Kv k="SKU" v={s(overview?.['sku_name'])} />
              <Kv k="Module" v={`${s(fleet['pv_module_make'])} ${s(fleet['pv_module_model'])}`} />
              <Kv k="STC Rating" v={fleet['stc_rating2'] != null ? `${n(fleet['stc_rating2'], 0)} W` : '—'} />
            </div>
          </CardContent>
        </Card>
      )}

      {overview && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="h-4 w-4 text-primary" />
              Production Overview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 md:grid-cols-4">
              <Kv k="Energy" v={`${n(overview['energy_kwh'])} kWh`} />
              <Kv k="Readings" v={s(overview['reading_count'])} />
              <Kv k="Days" v={s(overview['day_count'])} />
              <Kv k="First reading" v={s(overview['first_reading'])} />
              <Kv k="Last reading" v={s(overview['last_reading'])} />
              <Kv k="Avg AC power" v={`${n(overview['avg_ac_power_w'], 0)} W`} />
              <Kv k="Avg DC power" v={`${n(overview['avg_dc_power_w'], 0)} W`} />
              <Kv k="Max temp" v={`${n(overview['max_temp_c'], 1)} °C`} />
            </div>
          </CardContent>
        </Card>
      )}

      {acPower && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Battery className="h-4 w-4 text-primary" />
              AC Power Statistics
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 md:grid-cols-4">
              <Kv k="Max" v={`${n(acPower['max_ac_power_w'], 0)} W`} />
              <Kv k="Median" v={`${n(acPower['median_ac_power_w'], 0)} W`} />
              <Kv k="Average" v={`${n(acPower['avg_ac_power_w'], 0)} W`} />
              <Kv k="Min" v={`${n(acPower['min_ac_power_w'], 0)} W`} />
              <Kv k="Readings" v={s(acPower['reading_count'])} />
            </div>
          </CardContent>
        </Card>
      )}

      {daily && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Sun className="h-4 w-4 text-primary" />
              Daily Production
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 md:grid-cols-4">
              <Kv k="Days" v={s(daily['days'])} />
              <Kv k="Avg daily" v={`${n(daily['avg_daily_kwh'])} kWh`} />
              <Kv k="Median daily" v={`${n(daily['median_daily_kwh'])} kWh`} />
              <Kv k="Min daily" v={`${n(daily['min_daily_kwh'])} kWh`} />
              <Kv k="Max daily" v={`${n(daily['max_daily_kwh'])} kWh`} />
            </div>
          </CardContent>
        </Card>
      )}

      {environment && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Thermometer className="h-4 w-4 text-primary" />
              AC Voltage · Frequency · Temperature
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 md:grid-cols-4">
              <Kv k="AC voltage" v={`${n(environment['avg_ac_voltage_v'], 1)} V (median ${n(environment['median_ac_voltage_v'], 1)})`} />
              <Kv k="AC freq" v={`${n(environment['avg_ac_frequency_hz'], 2)} Hz (median ${n(environment['median_ac_frequency_hz'], 2)})`} />
              <Kv k="Temp" v={`${n(environment['avg_temp_c'], 1)} °C (median ${n(environment['median_temp_c'], 1)})`} />
              <Kv k="Temp range" v={`${n(environment['min_temp_c'], 1)} – ${n(environment['max_temp_c'], 1)} °C`} />
              <Kv k="Voltage range" v={`${n(environment['min_ac_voltage_v'], 1)} – ${n(environment['max_ac_voltage_v'], 1)} V`} />
              <Kv k="Freq range" v={`${n(environment['min_ac_frequency_hz'], 2)} – ${n(environment['max_ac_frequency_hz'], 2)} Hz`} />
            </div>
          </CardContent>
        </Card>
      )}

      {clipping && (
        <Card>
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="h-4 w-4 text-primary" />
              Clipping
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ClippingBadge classification={String(clipping['classification'] ?? 'unknown')} />
            <div className="mt-2 text-sm">
              <Kv k="Events" v={s(clipping['total_event_count'])} />
            </div>
            {Array.isArray(clipping['events']) && (clipping['events'] as Record<string, unknown>[]).length > 0 && (
              <div className="mt-3 rounded border bg-muted/20 p-2">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Events (date · start · end · duration)</p>
                <div className="space-y-1">
                  {(clipping['events'] as Record<string, unknown>[]).slice(0, 6).map((e, i) => (
                    <div key={i} className="flex flex-wrap gap-x-3 text-xs">
                      <span className="font-mono text-muted-foreground">{s(e['date'])}</span>
                      <span>{n(e['start_hour'], 0)}:00 → {n(e['end_hour'], 0)}:00</span>
                      <span className="font-semibold">{n(e['duration_hours'], 1)} h</span>
                      <span className="text-muted-foreground">{s(e['type'])}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {Boolean(row['telemetry_note']) && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{String(row['telemetry_note'])}</p>
        </div>
      )}
    </div>
  )
}

// ─── Standalone renderer for find_nearby_sites results ───────────────────────

interface NearbyResultRendererProps {
  rows: Record<string, unknown>[]
}

export function NearbyResultRenderer({ rows }: NearbyResultRendererProps) {
  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <AlertTriangle className="h-4 w-4" />
        No comparable sites found within the search radius.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Users className="h-4 w-4 text-primary" />
        {rows.length} Comparable Site{rows.length !== 1 ? 's' : ''} — v2 Similarity Score (max 10)
      </div>
      {rows.map((r, i) => <PeerScoreCard key={i} p={r} />)}
      <p className="text-[10px] text-muted-foreground">
        Score = Geography 3pts · Module Power 2pts · Microinverter 2.5pts · Wafer 2pts · Irradiance 0.5pts.
        Missing fields are excluded from numerator and denominator (shown as n/a). Data Coverage = % of weight with available data.
      </p>
    </div>
  )
}

// ─── Fleet Search Result ───────────────────────────────────────────────────────

interface FleetSearchResultProps {
  rows: Record<string, unknown>[]
  filters?: Record<string, unknown>
}

function IrrBadge({ val }: { val: number | null }) {
  if (val == null) return <span className="text-muted-foreground">—</span>
  const cls =
    val >= 5.5 ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
    : val >= 4.5 ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100'
    : val >= 3.5 ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
    : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${cls}`}>
      {val.toFixed(1)} kWh/m²/day
    </span>
  )
}

export function FleetSearchResult({ rows, filters = {} }: FleetSearchResultProps) {
  const appliedFilters: string[] = []
  if (filters['microinverter'])  appliedFilters.push(`Inverter: ${filters['microinverter']}`)
  if (filters['minPowerW'] != null || filters['maxPowerW'] != null)
    appliedFilters.push(`Power: ${filters['minPowerW'] ?? 0} – ${filters['maxPowerW'] ?? '∞'} W`)
  if (filters['country'])        appliedFilters.push(`Country: ${filters['country']}`)
  if (filters['state'])          appliedFilters.push(`State: ${filters['state']}`)
  if (filters['irradiance'])     appliedFilters.push(`Irradiance: ${filters['irradiance']}`)
  if (filters['moduleWafer'])    appliedFilters.push(`Wafer: ${filters['moduleWafer']}`)
  if (filters['moduleMake'])     appliedFilters.push(`Module make: ${filters['moduleMake']}`)

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MapPin className="h-4 w-4 text-primary" />
          {rows.length} site{rows.length !== 1 ? 's' : ''} found
        </div>
        {appliedFilters.map((f, i) => (
          <Badge key={i} variant="secondary" className="text-[10px]">{f}</Badge>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>No sites matched these criteria. Try relaxing the power range, removing the irradiance filter, or broadening the country.</p>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r, i) => {
            const irr = r['irr_ann_kwh_m2_month'] != null ? Number(r['irr_ann_kwh_m2_month']) : null
            const loc = [r['city'], r['state'], r['country']].filter(Boolean).join(', ')
            const module = [r['pv_module_make'], r['pv_module_model']].filter(Boolean).join(' ')
            const power = r['stc_rating_w'] != null ? `${Number(r['stc_rating_w']).toFixed(0)} W` : null
            const inverter = s(r['model_name'] ?? r['product_type'])
            return (
              <div
                key={i}
                className="rounded-lg border bg-card p-3 text-xs shadow-sm transition-colors hover:bg-muted/40"
              >
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <span className="font-mono text-sm font-bold text-primary">{s(r['site_id'])}</span>
                  <IrrBadge val={irr} />
                </div>
                <p className="mb-1 truncate text-muted-foreground">{loc || '—'}</p>
                <div className="space-y-0.5">
                  <div className="flex gap-1">
                    <span className="w-16 shrink-0 text-muted-foreground">Inverter</span>
                    <span className="font-medium">{inverter}</span>
                  </div>
                  <div className="flex gap-1">
                    <span className="w-16 shrink-0 text-muted-foreground">Module</span>
                    <span className="font-medium truncate">{module || '—'}{power ? ` · ${power}` : ''}</span>
                  </div>
                  <div className="flex gap-1">
                    <span className="w-16 shrink-0 text-muted-foreground">Wafer</span>
                    <span>{s(r['module_wafer'])}</span>
                  </div>
                  <div className="flex gap-1">
                    <span className="w-16 shrink-0 text-muted-foreground">DC/AC</span>
                    <span>{r['dc_ac_ratio'] != null ? Number(r['dc_ac_ratio']).toFixed(3) : '—'}</span>
                    <span className="ml-2 text-muted-foreground">Units</span>
                    <span>{s(r['unit_count'])}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
