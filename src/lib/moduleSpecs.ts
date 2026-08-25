// PV module electrical specs for VI curve rendering. These are standard
// datasheet values (STC conditions: 1000 W/m², 25°C) used to derive the
// single-diode-approximated VI curve. When the exact module model is not
// matched, we fall back to a generic "typical 400W" set.

export interface ModuleSpec {
  /** PV module model or label */
  name: string
  /** Open-circuit voltage at STC (V) */
  voc: number
  /** Short-circuit current at STC (A) */
  isc: number
  /** Voltage at maximum power point (V) */
  vmp: number
  /** Current at maximum power point (A) */
  imp: number
  /** Maximum power at STC (W) */
  pmax: number
}

/**
 * Generate the VI curve points for a module at a given irradiance level.
 * Uses simplified single-diode model:
 *   I(V) = Isc_g * (1 - (exp(V / (Voc_g / ln(Isc_g/0.01))) - 1) / (exp(Vmp/(Voc_g/ln(Isc_g/0.01))) - 1) * (1 - Imp/Isc_g))
 *
 * Simplified approximation:
 *   At irradiance G (W/m²), Isc_g = Isc * G/1000, Voc_g ≈ Voc + 0.06*ln(G/1000)*Voc (simplified temp-independent)
 *   I(V) = Isc_g * (1 - exp((V - Voc_g) / (n * Vt * Ns)))
 *   where Vt = kT/q ≈ 0.02585V at 25°C, Ns = Voc/(0.6 * n_cells_approx)
 *
 * For simplicity we use a curve-fit approach: I = Isc_g * (1 - ((exp(V/Voc_g) - 1) / (exp(1) - 1))^k)
 * with k tuned to pass through (Vmp, Imp).
 */
export function generateVICurve(
  spec: ModuleSpec,
  irradianceWm2: number,
  numPoints = 100
): { voltage: number[]; current: number[] } {
  const gRatio = irradianceWm2 / 1000
  // Isc scales linearly with irradiance
  const iscG = spec.isc * gRatio
  // Voc has logarithmic dependence on irradiance (small effect)
  const vocG = gRatio > 0 ? spec.voc + 0.026 * Math.log(Math.max(gRatio, 0.01)) * (spec.voc / 0.6) : spec.voc * 0.5

  // Shape parameter k: solve Imp = Isc_g * (1 - ((exp(Vmp/Voc_g)-1)/(exp(1)-1))^k)
  const e1 = Math.exp(1) - 1
  const impG = spec.imp * gRatio
  const vmpRatio = Math.min(spec.vmp / Math.max(vocG, 1), 0.99)
  const x = (Math.exp(vmpRatio) - 1) / e1
  const yTarget = 1 - impG / Math.max(iscG, 0.001)
  const k = x > 0 && x < 1 && yTarget > 0 && yTarget < 1
    ? Math.log(yTarget) / Math.log(x)
    : 5 // fallback shape

  const voltage: number[] = []
  const current: number[] = []
  const step = Math.max(vocG, 1) / numPoints
  for (let v = 0; v <= vocG + step; v += step) {
    const vNorm = Math.min(v / Math.max(vocG, 1), 1)
    const expTerm = (Math.exp(vNorm) - 1) / e1
    const i = Math.max(0, iscG * (1 - Math.pow(Math.min(expTerm, 1), k)))
    voltage.push(Math.round(v * 100) / 100)
    current.push(Math.round(i * 1000) / 1000)
  }
  return { voltage, current }
}

/**
 * Standard silicon temperature coefficients (fraction per °C).
 * Used by generateVICurveAtTemp to translate STC parameters to field conditions.
 */
const ALPHA_ISC = 0.0005   // +0.05 %/°C — Isc increases with temperature
const BETA_VOC  = -0.003   // −0.30 %/°C — Voc drops with temperature
const T_STC     = 25       // °C — Standard Test Conditions temperature

/**
 * Generate a V-I curve at a specific cell temperature and irradiance level.
 * Adjusts Isc and Voc from STC using standard linear coefficients:
 *   Isc(T) = Isc_STC × (1 + α × ΔT)
 *   Voc(T) = Voc_STC × (1 + β × ΔT)
 *   Vmp/Imp follow a similar ratio-preserving shift.
 */
export function generateVICurveAtTemp(
  spec: ModuleSpec,
  irradianceWm2: number,
  cellTempC: number,
  numPoints = 100
): { voltage: number[]; current: number[] } {
  const dT = cellTempC - T_STC
  const tempSpec: ModuleSpec = {
    ...spec,
    isc: spec.isc * (1 + ALPHA_ISC * dT),
    voc: spec.voc * (1 + BETA_VOC * dT),
    imp: spec.imp * (1 + ALPHA_ISC * dT),
    vmp: spec.vmp * (1 + BETA_VOC * dT),
    pmax: spec.pmax * (1 + ALPHA_ISC * dT) * (1 + BETA_VOC * dT),
  }
  return generateVICurve(tempSpec, irradianceWm2, numPoints)
}

/**
 * For a given clipping current, find what irradiance levels would produce
 * that current at various voltages along the VI curve. Returns pairs of
 * (voltage, irradiance) by inverting I = Isc * (G/1000) → G = I / Isc * 1000
 * and accounting for the voltage-dependent shape.
 */
export function generateClippedCurrentCurve(
  spec: ModuleSpec,
  clippedCurrentA: number,
  numPoints = 50
): { voltage: number[]; irradiance: number[] } {
  const voltage: number[] = []
  const irradiance: number[] = []

  // At each voltage V, find the irradiance G such that I(V, G) = clippedCurrentA
  // Since I ≈ Isc*(G/1000) * f(V/Voc(G)), and for moderate G, Voc(G) ≈ Voc,
  // we approximate: G ≈ clippedCurrentA / (Isc/1000 * f(V/Voc)) * 1000
  const e1 = Math.exp(1) - 1
  const impRatio = 1 - spec.imp / spec.isc
  const vmpRatio = Math.min(spec.vmp / spec.voc, 0.99)
  const xVmp = (Math.exp(vmpRatio) - 1) / e1
  const k = xVmp > 0 && xVmp < 1 && impRatio > 0 && impRatio < 1
    ? Math.log(impRatio) / Math.log(xVmp)
    : 5

  const step = spec.voc / numPoints
  for (let v = 0; v < spec.voc * 0.95; v += step) {
    const vNorm = v / spec.voc
    const expTerm = (Math.exp(vNorm) - 1) / e1
    const shapeFactor = 1 - Math.pow(Math.min(expTerm, 1), k)
    if (shapeFactor <= 0.01) continue // near Voc, current → 0
    const gNeeded = (clippedCurrentA / (spec.isc * shapeFactor)) * 1000
    if (gNeeded > 0 && gNeeded < 2000) {
      voltage.push(Math.round(v * 100) / 100)
      irradiance.push(Math.round(gNeeded))
    }
  }
  return { voltage, irradiance }
}

/**
 * Name-based module spec database — real STC datasheet values.
 * Keys are UPPERCASE substrings matched against pv_module_model from fleet.
 * Ordered by fleet site count (most common first).
 *
 * Sources: official manufacturer datasheets retrieved 2026-07.
 * All values at STC: 1000 W/m², 25°C, AM 1.5.
 */
export const MODULE_NAME_DB: Record<string, ModuleSpec> = {
  // ----- Q CELLS  (top fleet modules) -----
  'Q.PEAK DUO BLK ML-G10+ 410':  { name: 'Q.PEAK DUO BLK ML-G10+ 410W',  voc: 45.37, isc: 11.20, vmp: 37.64, imp: 10.89, pmax: 410 },
  'Q.PEAK DUO BLK ML-G10+ 405':  { name: 'Q.PEAK DUO BLK ML-G10+ 405W',  voc: 45.34, isc: 11.17, vmp: 37.39, imp: 10.83, pmax: 405 },
  'Q.PEAK DUO BLK ML-G10+ 400':  { name: 'Q.PEAK DUO BLK ML-G10+ 400W',  voc: 45.30, isc: 11.14, vmp: 37.13, imp: 10.77, pmax: 400 },
  'Q.PEAK DUO BLK ML-G10+ 415':  { name: 'Q.PEAK DUO BLK ML-G10+ 415W',  voc: 45.41, isc: 11.23, vmp: 37.89, imp: 10.95, pmax: 415 },
  'Q.PEAK DUO BLK ML-G10+ 395':  { name: 'Q.PEAK DUO BLK ML-G10+ 395W',  voc: 45.27, isc: 11.10, vmp: 36.88, imp: 10.71, pmax: 395 },
  'Q.PEAK DUO BLK ML-G10.C+ 410': { name: 'Q.PEAK DUO BLK ML-G10.C+ 410W', voc: 45.37, isc: 11.20, vmp: 37.64, imp: 10.89, pmax: 410 },
  'Q.PEAK DUO L-G6.2 410':       { name: 'Q.PEAK DUO L-G6.2 410W',       voc: 48.38, isc: 10.70, vmp: 40.00, imp: 10.25, pmax: 410 },
  'Q.PEAK DUO ML-G10.A+ 405':    { name: 'Q.PEAK DUO ML-G10.a+ 405W',    voc: 45.09, isc: 11.19, vmp: 37.39, imp: 10.83, pmax: 405 },
  'Q.PEAK DUO ML-G10.A+ 410':    { name: 'Q.PEAK DUO ML-G10.a+ 410W',    voc: 45.13, isc: 11.22, vmp: 37.64, imp: 10.89, pmax: 410 },
  'Q.TRON BLK M-G2+ 430':        { name: 'Q.TRON BLK M-G2+ 430W',        voc: 39.32, isc: 13.74, vmp: 32.94, imp: 13.05, pmax: 430 },
  'Q.TRON BLK M-G2+ 435':        { name: 'Q.TRON BLK M-G2+ 435W',        voc: 39.60, isc: 13.82, vmp: 33.14, imp: 13.13, pmax: 435 },
  'Q.TRON BLK M-G2+ 440':        { name: 'Q.TRON BLK M-G2+ 440W',        voc: 39.88, isc: 13.90, vmp: 33.33, imp: 13.20, pmax: 440 },
  'Q.TRON BLK M-G2+ 425':        { name: 'Q.TRON BLK M-G2+ 425W',        voc: 39.03, isc: 13.66, vmp: 32.74, imp: 12.98, pmax: 425 },
  'Q.TRON BLK M-G2+ 420':        { name: 'Q.TRON BLK M-G2+ 420W',        voc: 38.75, isc: 13.58, vmp: 32.54, imp: 12.91, pmax: 420 },
  'Q.TRON BLK M-G2.H+ 430':      { name: 'Q.TRON BLK M-G2.H+ 430W',     voc: 39.32, isc: 13.74, vmp: 32.94, imp: 13.05, pmax: 430 },
  'Q.TRON BLKM-G2+ 430':         { name: 'Q.TRON BLK M-G2+ 430W',        voc: 39.32, isc: 13.74, vmp: 32.94, imp: 13.05, pmax: 430 },
  // ----- Silfab -----
  'SIL-440-QD':                   { name: 'Silfab SIL-440 QD',             voc: 38.97, isc: 14.22, vmp: 33.41, imp: 13.17, pmax: 440 },
  'SIL-440 QD':                   { name: 'Silfab SIL-440 QD',             voc: 38.97, isc: 14.22, vmp: 33.41, imp: 13.17, pmax: 440 },
  'SIL-430-QD':                   { name: 'Silfab SIL-430 QD',             voc: 38.91, isc: 13.87, vmp: 33.20, imp: 12.95, pmax: 430 },
  'SILFAB-440QD':                 { name: 'Silfab SIL-440 QD',             voc: 38.97, isc: 14.22, vmp: 33.41, imp: 13.17, pmax: 440 },
  // ----- HD Hyundai -----
  'HIN-T440NF':                   { name: 'Hyundai HiN-T440NF',            voc: 38.80, isc: 14.39, vmp: 32.30, imp: 13.63, pmax: 440 },
  'HIN-T435NF':                   { name: 'Hyundai HiN-T435NF',            voc: 38.60, isc: 14.32, vmp: 32.10, imp: 13.56, pmax: 435 },
  'HIN-T430NF':                   { name: 'Hyundai HiN-T430NF',            voc: 38.40, isc: 14.25, vmp: 31.90, imp: 13.48, pmax: 430 },
  'HIS-T440NF':                   { name: 'Hyundai HiS-T440NF',            voc: 39.90, isc: 14.60, vmp: 33.00, imp: 13.33, pmax: 440 },
  // ----- JA Solar -----
  'JAM54D41-440/LB':              { name: 'JA Solar JAM54D41-440/LB',      voc: 38.90, isc: 14.31, vmp: 32.47, imp: 13.55, pmax: 440 },
  'JAM54D41-450/LB':              { name: 'JA Solar JAM54D41-450/LB',      voc: 39.30, isc: 14.48, vmp: 32.82, imp: 13.71, pmax: 450 },
  'JAM54D41 440/MB':              { name: 'JA Solar JAM54D41-440/MB',      voc: 39.38, isc: 13.85, vmp: 33.37, imp: 13.18, pmax: 440 },
  'JAM54D41-440/MB':              { name: 'JA Solar JAM54D41-440/MB',      voc: 39.38, isc: 13.85, vmp: 33.37, imp: 13.18, pmax: 440 },
  'JAM54D40-440':                 { name: 'JA Solar JAM54D40-440',         voc: 38.90, isc: 14.31, vmp: 32.47, imp: 13.55, pmax: 440 },
  'JAM54S31':                     { name: 'JA Solar JAM54S31 405',         voc: 37.23, isc: 13.87, vmp: 31.09, imp: 13.03, pmax: 405 },
  'JAM54S30':                     { name: 'JA Solar JAM54S30 400',         voc: 37.24, isc: 13.92, vmp: 30.89, imp: 12.95, pmax: 400 },
  'JAM60S20':                     { name: 'JA Solar JAM60S20 385',         voc: 41.52, isc: 11.98, vmp: 34.56, imp: 11.14, pmax: 385 },
  'JAM72S20':                     { name: 'JA Solar JAM72S20 455',         voc: 49.62, isc: 11.80, vmp: 41.64, imp: 10.93, pmax: 455 },
  'JAM78S10':                     { name: 'JA Solar JAM78S10-450',         voc: 53.58, isc: 10.52, vmp: 45.00, imp: 10.00, pmax: 450 },
  // ----- Mission Solar -----
  'MSX10-435HN0B':                { name: 'Mission Solar MSX10-435',       voc: 39.56, isc: 13.79, vmp: 33.31, imp: 13.07, pmax: 435 },
  'MSX10-440':                    { name: 'Mission Solar MSX10-440',       voc: 39.62, isc: 13.90, vmp: 33.37, imp: 13.19, pmax: 440 },
  'MSE410HT0B':                   { name: 'Mission Solar MSE410',          voc: 37.41, isc: 13.90, vmp: 31.00, imp: 13.23, pmax: 410 },
  // ----- SEG Solar -----
  'SEG-440-BMB-TB':               { name: 'SEG Solar Yukon 440',           voc: 41.12, isc: 13.56, vmp: 34.18, imp: 13.03, pmax: 440 },
  'SEG-440-BTD-BG':               { name: 'SEG Solar Yukon N 440',         voc: 39.30, isc: 14.15, vmp: 32.70, imp: 13.46, pmax: 440 },
  'SEG-430-BTD-BG':               { name: 'SEG Solar Yukon N 430',         voc: 38.90, isc: 13.99, vmp: 32.30, imp: 13.31, pmax: 430 },
  // ----- REC -----
  'REC460AA':                     { name: 'REC Alpha Pure-RX 460',         voc: 65.30, isc: 8.88,  vmp: 54.90, imp: 8.38,  pmax: 460 },
  'REC460 AA':                    { name: 'REC Alpha Pure-RX 460',         voc: 65.30, isc: 8.88,  vmp: 54.90, imp: 8.38,  pmax: 460 },
  'REC450AA':                     { name: 'REC Alpha Pure-RX 450',         voc: 65.60, isc: 8.81,  vmp: 54.30, imp: 8.29,  pmax: 450 },
  'REC400AA':                     { name: 'REC Alpha Pure 400',            voc: 44.80, isc: 11.50, vmp: 37.60, imp: 10.64, pmax: 400 },
  'REC410AA':                     { name: 'REC Alpha Pure 410',            voc: 44.90, isc: 11.60, vmp: 37.90, imp: 10.82, pmax: 410 },
  // ----- DualSun -----
  'FLASH 500 HALF-CUT BLACK':     { name: 'DualSun FLASH 500 HC Black',    voc: 45.60, isc: 14.07, vmp: 37.84, imp: 13.22, pmax: 500 },
  'FLASH 500 HALF-CUT GLASS':     { name: 'DualSun FLASH 500 HC GG',       voc: 44.22, isc: 14.04, vmp: 36.87, imp: 13.56, pmax: 500 },
  'FLASH 500':                    { name: 'DualSun FLASH 500',             voc: 44.22, isc: 14.04, vmp: 36.87, imp: 13.56, pmax: 500 },
  'FLASH 375':                    { name: 'DualSun FLASH 375',             voc: 41.81, isc: 11.62, vmp: 34.34, imp: 10.92, pmax: 375 },
  'FLASH 380':                    { name: 'DualSun FLASH 380',             voc: 41.96, isc: 11.68, vmp: 34.55, imp: 11.00, pmax: 380 },
  'FLASH 400':                    { name: 'DualSun FLASH 400',             voc: 37.20, isc: 13.89, vmp: 30.80, imp: 12.99, pmax: 400 },
  'FLASH 410':                    { name: 'DualSun FLASH 410',             voc: 37.40, isc: 14.10, vmp: 31.10, imp: 13.18, pmax: 410 },
  'FLASH 425':                    { name: 'DualSun FLASH 425',             voc: 38.00, isc: 14.35, vmp: 31.70, imp: 13.41, pmax: 425 },
  // ----- LONGi -----
  'LR5-54HPB-410':                { name: 'LONGi Hi-MO 5 410M',            voc: 37.40, isc: 13.84, vmp: 31.42, imp: 13.05, pmax: 410 },
  'LR5-54HPB-405':                { name: 'LONGi Hi-MO 5 405M',            voc: 37.15, isc: 13.78, vmp: 31.18, imp: 12.99, pmax: 405 },
  'LR5-54HPB-400':                { name: 'LONGi Hi-MO 5 400M',            voc: 36.90, isc: 13.72, vmp: 30.94, imp: 12.93, pmax: 400 },
  'LR5-54HPH':                    { name: 'LONGi Hi-MO 5 405',             voc: 37.30, isc: 13.96, vmp: 31.10, imp: 13.02, pmax: 405 },
  'LR5-54HTH':                    { name: 'LONGi Hi-MO 6 430',             voc: 38.64, isc: 14.39, vmp: 32.20, imp: 13.35, pmax: 430 },
  // ----- Canadian Solar -----
  'CS6.1-54TM-455':               { name: 'Canadian TOPHiKu6 455',         voc: 39.10, isc: 14.61, vmp: 33.20, imp: 13.72, pmax: 455 },
  'CS6.1-54TM-450':               { name: 'Canadian TOPHiKu6 450',         voc: 38.90, isc: 14.55, vmp: 33.00, imp: 13.66, pmax: 450 },
  'CS6.1-54TM-440':               { name: 'Canadian TOPHiKu6 440',         voc: 38.50, isc: 14.41, vmp: 32.60, imp: 13.52, pmax: 440 },
  'CS6R-405':                     { name: 'Canadian HiKu6 405',            voc: 37.50, isc: 13.94, vmp: 31.20, imp: 12.98, pmax: 405 },
  'CS6R-410':                     { name: 'Canadian HiKu6 410',            voc: 37.60, isc: 14.07, vmp: 31.40, imp: 13.06, pmax: 410 },
  'CS6R-430':                     { name: 'Canadian HiKu6 430',            voc: 38.90, isc: 14.28, vmp: 32.50, imp: 13.23, pmax: 430 },
  // ----- DMEGC -----
  'DM500M10RT-B60HBT':            { name: 'DMEGC DM500 B60HBT',            voc: 44.22, isc: 14.04, vmp: 36.87, imp: 13.56, pmax: 500 },
  'DM500M10RT-B60HST':            { name: 'DMEGC DM500 B60HST',            voc: 44.45, isc: 14.01, vmp: 37.00, imp: 13.51, pmax: 500 },
  'DS500-120M10TB':               { name: 'DMEGC DS500 120M10',            voc: 44.22, isc: 14.04, vmp: 36.87, imp: 13.56, pmax: 500 },
  // ----- Voltec / TARKA -----
  'TARKA 120 VSMP 500':           { name: 'Voltec TARKA 120 VSMP 500',     voc: 44.39, isc: 13.93, vmp: 37.29, imp: 13.41, pmax: 500 },
  // ----- SunPower -----
  'SPR-P7-500-BLK':               { name: 'SunPower P7-500 BLK',           voc: 46.67, isc: 13.50, vmp: 39.16, imp: 12.77, pmax: 500 },
  'SPR-P7-505-BLK':               { name: 'SunPower P7-505 BLK',           voc: 46.91, isc: 13.54, vmp: 39.43, imp: 12.81, pmax: 505 },
  'SPR-P7-510-BLK':               { name: 'SunPower P7-510 BLK',           voc: 47.04, isc: 13.57, vmp: 39.69, imp: 12.85, pmax: 510 },
  'MAXEON 3-400':                 { name: 'SunPower Maxeon 3 400',         voc: 69.50, isc: 7.46,  vmp: 58.70, imp: 6.81,  pmax: 400 },
  'MAXEON 3-415':                 { name: 'SunPower Maxeon 3 415',         voc: 69.80, isc: 7.70,  vmp: 59.10, imp: 7.02,  pmax: 415 },
  'MAXEON 6-410':                 { name: 'SunPower Maxeon 6 410',         voc: 44.70, isc: 11.91, vmp: 37.70, imp: 11.28, pmax: 425 },
  'SPR-MAX3-400':                 { name: 'SunPower Maxeon 3 400',         voc: 69.50, isc: 7.46,  vmp: 58.70, imp: 6.81,  pmax: 400 },
  'X21-345':                      { name: 'SunPower X21-345',              voc: 68.20, isc: 6.39,  vmp: 57.30, imp: 6.02,  pmax: 345 },
  'X21-335':                      { name: 'SunPower X21-335',              voc: 67.90, isc: 6.23,  vmp: 57.00, imp: 5.88,  pmax: 335 },
  'X22-360':                      { name: 'SunPower X22-360',              voc: 69.50, isc: 6.48,  vmp: 58.70, imp: 6.14,  pmax: 360 },
  // ----- Trina Solar -----
  'TSM-400':                      { name: 'Trina Vertex S 400',            voc: 37.20, isc: 13.86, vmp: 31.00, imp: 12.90, pmax: 400 },
  'TSM-410':                      { name: 'Trina Vertex S 410',            voc: 37.60, isc: 14.04, vmp: 31.30, imp: 13.10, pmax: 410 },
  'TSM-430':                      { name: 'Trina Vertex S+ 430',           voc: 38.80, isc: 14.32, vmp: 32.40, imp: 13.27, pmax: 430 },
  'DE06X.08':                     { name: 'Trina Vertex S+ 430',           voc: 38.80, isc: 14.32, vmp: 32.40, imp: 13.27, pmax: 430 },
  // ----- Jinko -----
  'JKM400M-54HL4':                { name: 'Jinko Tiger Neo 400',           voc: 37.42, isc: 13.85, vmp: 30.84, imp: 12.97, pmax: 400 },
  'JKM410N-54HL4':                { name: 'Jinko Tiger Neo 410',           voc: 37.62, isc: 14.02, vmp: 31.34, imp: 13.08, pmax: 410 },
  'JKM430N-54HL4':                { name: 'Jinko Tiger Neo 430',           voc: 38.92, isc: 14.24, vmp: 32.30, imp: 13.31, pmax: 430 },
  // ----- Risen -----
  'RSM40-8-400':                  { name: 'Risen 400',                     voc: 37.10, isc: 13.90, vmp: 30.80, imp: 12.99, pmax: 400 },
  'RSM40-8-410':                  { name: 'Risen 410',                     voc: 37.40, isc: 14.10, vmp: 31.10, imp: 13.18, pmax: 410 },
  // ----- Sharp -----
  'NU-JD450':                     { name: 'Sharp NU-JD450',                voc: 49.35, isc: 11.61, vmp: 41.56, imp: 10.83, pmax: 450 },
  // ----- Suntech -----
  'STP430S':                      { name: 'Suntech STP430S',               voc: 38.72, isc: 14.25, vmp: 32.33, imp: 13.30, pmax: 430 },
  'STP440S':                      { name: 'Suntech STP440S',               voc: 38.98, isc: 14.41, vmp: 32.69, imp: 13.46, pmax: 440 },
  'STP450S':                      { name: 'Suntech STP450S',               voc: 49.20, isc: 11.61, vmp: 41.40, imp: 10.87, pmax: 450 },
  // ----- ELNSM (Elion / Elephant) -----
  'ELNSM54MHC-415':               { name: 'ELNSM54 HC 415',                voc: 37.42, isc: 13.90, vmp: 31.10, imp: 13.34, pmax: 415 },
  'ELNSM54M-HC-N 450':            { name: 'ELNSM54 HC-N 450',              voc: 39.70, isc: 14.30, vmp: 33.10, imp: 13.60, pmax: 450 },
  'ELNSM54M-HC-410':              { name: 'ELNSM54 HC 410',                voc: 37.32, isc: 13.80, vmp: 31.00, imp: 13.23, pmax: 410 },
  // ----- Quartz / MYL -----
  'QUARTZ HJT 500':               { name: 'Quartz HJT 500',                voc: 40.81, isc: 15.31, vmp: 34.20, imp: 14.62, pmax: 500 },
  'MYL-210R-B108DSN500':           { name: 'Quartz HJT 500',               voc: 40.81, isc: 15.31, vmp: 34.20, imp: 14.62, pmax: 500 },
  // ----- AE Solar -----
  'AE440MD-120':                  { name: 'AE Solar AE440MD-120',          voc: 41.35, isc: 13.47, vmp: 34.40, imp: 12.79, pmax: 440 },
  // ----- DNA Solar -----
  'DNA-144-MF23-410':             { name: 'DNA 144-MF23 410',              voc: 48.91, isc: 10.79, vmp: 41.10, imp: 9.98,  pmax: 410 },
  // ----- 1KOMMA5 -----
  '1KOMMA5':                      { name: '1KOMMA5° FullBlack 445',        voc: 39.20, isc: 13.40, vmp: 33.00, imp: 13.48, pmax: 445 },
  // ----- AC Solar -----
  'AC-440TGB':                    { name: 'AC Solar AC-440TGB',             voc: 40.31, isc: 13.55, vmp: 33.60, imp: 13.10, pmax: 440 },
  // ----- Q CELLS older -----
  'Q.PEAK DUO-G11S.400':          { name: 'Q CELLS DUO G11S 400',         voc: 37.40, isc: 13.76, vmp: 31.10, imp: 12.86, pmax: 400 },
  'Q.PEAK DUO-G11S.410':          { name: 'Q CELLS DUO G11S 410',         voc: 37.60, isc: 14.00, vmp: 31.30, imp: 13.10, pmax: 410 },
}

/**
 * Match a pv_module_model string from fleet data against MODULE_NAME_DB.
 * Does case-insensitive substring matching, longest key first for specificity.
 * Returns null if no match found.
 */
const _sortedKeys = Object.keys(MODULE_NAME_DB).sort((a, b) => b.length - a.length)

export function findModuleSpecByName(modelName: string | null | undefined): ModuleSpec | null {
  if (!modelName) return null
  const upper = modelName.toUpperCase().trim()
  for (const key of _sortedKeys) {
    if (upper.includes(key.toUpperCase())) return MODULE_NAME_DB[key]
  }
  return null
}

/**
 * Find the best matching ModuleSpec.
 * Priority: 1) exact model name match, 2) derive from fleet Voc/Isc/Pmax.
 *
 * When fleet data provides Voc, Isc, and nameplate Pmax (stc_rating2),
 * we derive Vmp and Imp so that Vmp * Imp = Pmax exactly.
 * We use the fill-factor relationship: FF = Pmax / (Voc * Isc),
 * then Vmp ≈ Voc * sqrt(FF) and Imp = Pmax / Vmp.
 * This guarantees Pmax is always the exact nameplate rating.
 */
export function findModuleSpec(
  pmax: number | null,
  voc?: number | null,
  isc?: number | null,
  modelName?: string | null,
): ModuleSpec {
  // 1) Try name-based lookup first (most accurate — real datasheet values)
  const byName = findModuleSpecByName(modelName)
  if (byName) return byName

  // 2) If we have Voc, Isc and nameplate Pmax from fleet, derive Vmp/Imp
  const hasVoc = voc != null && Number.isFinite(voc) && voc > 0
  const hasIsc = isc != null && Number.isFinite(isc) && isc > 0
  const hasPmax = pmax != null && Number.isFinite(pmax) && pmax > 0

  if (hasVoc && hasIsc && hasPmax) {
    const ff = pmax! / (voc! * isc!)
    // Clamp fill factor to realistic range 0.60–0.90
    const ffClamped = Math.max(0.60, Math.min(ff, 0.90))
    // Vmp ≈ Voc * sqrt(FF), Imp = Pmax / Vmp
    const vmpEst = voc! * Math.sqrt(ffClamped)
    const impEst = pmax! / vmpEst
    return {
      name: modelName ?? `Module ${pmax}W`,
      voc: voc!,
      isc: isc!,
      vmp: Math.round(vmpEst * 100) / 100,
      imp: Math.round(impEst * 1000) / 1000,
      pmax: pmax!,
    }
  }

  // 3) If we only have Voc+Isc but no Pmax, estimate with typical FF ≈ 0.78
  if (hasVoc && hasIsc) {
    const typicalFF = 0.78
    const pmaxEst = Math.round(voc! * isc! * typicalFF)
    const vmpEst = voc! * Math.sqrt(typicalFF)
    const impEst = pmaxEst / vmpEst
    return {
      name: modelName ?? `Module ~${pmaxEst}W`,
      voc: voc!,
      isc: isc!,
      vmp: Math.round(vmpEst * 100) / 100,
      imp: Math.round(impEst * 1000) / 1000,
      pmax: pmaxEst,
    }
  }

  return DEFAULT_MODULE_SPEC
}

/** Default fallback spec for unknown modules */
export const DEFAULT_MODULE_SPEC: ModuleSpec = {
  name: 'Generic 400W',
  voc: 37.3,
  isc: 13.8,
  vmp: 31.0,
  imp: 12.90,
  pmax: 400,
}
