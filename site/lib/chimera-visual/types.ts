// Renderer types from Chimera. See README.md for provenance.
export interface Vec {
  x: number;
  y: number;
}
export interface HumanArtic {
  jaw: number;
  tbX: number;
  tbY: number;
  ttX: number;
  ttY: number;
  ttCurl: number;
  root: number;
  lipAp: number;
  lipProt: number;
  lipWidth: number;
  labiodental: number;
  velum: number;
  larynx: number;
  epilarynx: number;
  ventricular: number;
  lateral: number;
  dorsum: number;
}

export interface HumanBody {
  name: string;
  /** overall size scale (1 = adult male) */
  scale: number;
  /** extra pharynx length scale (female/child have proportionally shorter pharynx) */
  pharynx: number;
  /** tongue body radius (cm, before scale) */
  tongueRadius: number;
  /** max lip width (cm, before scale) */
  lipWidth: number;
}

export interface GridSample {
  inner: Vec;
  outer: Vec;
  mid: Vec;
  d: number;
  area: number;
  s: number;
  region: 0 | 1 | 2 | 3;
  ray: number;
}

export interface HumanFrame {
  outer: Vec[];
  inner: Vec[];
  tongue: Vec[];
  velum: Vec[];
  upperLip: Vec[];
  lowerLip: Vec[];
  upperTeeth: Vec[];
  lowerTeeth: Vec[];
  jawBone: Vec[];
  epiglottis: Vec[];
  nasalCavity: Vec[];
  glottis: Vec;
  grid: GridSample[];
  length: number;
  pharynxLength: number;
  teethS: number;
  lipS: number;
  velumPort: number;
  lipArea: number;
  tongueCenter: Vec;
  tongueRadius: number;
  tip: Vec;
  splitIndex: number;
}

/** The original renderer supports this richer worklet telemetry. The site supplies null. */
export interface TelemetryMessage {
  nPh: number;
  nOr: number;
  beatStep?: number;
  t: {
    pressureRms: ArrayLike<number>;
    phAreas: Float32Array;
    orAreas: Float32Array;
    flow: ArrayLike<number>;
    phLen: number;
    orLen: number;
    noiseNode: number;
    noiseLevel: number;
    voicing: number;
    gate: number;
    f0: number;
    outRms: number;
  };
}
