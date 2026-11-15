//! Domestic-cat meow prototype: an 8 cm oral tract with a moving mandibular aperture.
//! The jaw changes tube areas, not a bank of human vowels. See docs/cat-prototype.md for
//! the physiological motivation and the limits of this reduced model.

use super::build::{CMH2O, fill_areas};
use super::mammal::{MammalAirway, MammalSpec, mammal_airway, mammal_noise, step_glottis};
use super::types::{
    CallDef, CallKey, CreatureDef, CreatureGroup, CreatureSim, Curve, GateTimes, ParamDef,
};
use crate::airway::network::{AirwayNetwork, Tube};
use crate::math::{js_min, smoothstep};
use std::sync::LazyLock;

const PITCH: usize = 0;
const JAW: usize = 1;
const EFFORT: usize = 2;
const ROUGH: usize = 3;
const PRESSURE: usize = 4;

/// Isolated prototype definition, deliberately outside the product's creature catalogue.
pub static CAT: LazyLock<CreatureDef> = LazyLock::new(def);

struct Cat {
    a: MammalAirway,
    tubes: Vec<(&'static str, Tube)>,
}

fn create(fs: f64) -> Box<dyn CreatureSim> {
    let mut a = mammal_airway(
        fs,
        MammalSpec {
            trachea: (9.0, 0.45),
            pharynx: (2.6, 0.65),
            oral: (5.4, 1.1),
            nasal: None,
            wall: None,
            wall_radiation: Some(0.08),
            coarse: None,
            nasal_radiates: None,
        },
        |_, _| {},
    );
    let g = &mut a.glottis_src.params;
    g.jitter = 0.004;
    g.shimmer = 0.025;
    g.drift = 3.0;
    let tubes = vec![
        ("trachea", a.trachea),
        ("pharynx", a.pharynx),
        ("oral", a.oral),
    ];
    Box::new(Cat { a, tubes })
}

impl CreatureSim for Cat {
    fn net(&self) -> Option<&AirwayNetwork> {
        Some(&self.a.net)
    }
    fn net_mut(&mut self) -> Option<&mut AirwayNetwork> {
        Some(&mut self.a.net)
    }
    fn tubes(&self) -> &[(&'static str, Tube)] {
        &self.tubes
    }
    fn gain(&self) -> f64 {
        1.8e-7
    }

    fn control(&mut self, p: &[f64], gate: f64, _dt: f64) {
        let a = &mut self.a;
        a.net
            .set_fixed_pressure(a.lungs, p[PRESSURE] * CMH2O * gate);
        let g = &mut a.glottis_src.params;
        g.f0 = p[PITCH];
        g.amplitude = 0.045;
        g.chink = 0.0015;
        g.effort = p[EFFORT];
        g.open_quotient = 0.72 - 0.18 * p[EFFORT];
        g.closure_sharpness = 0.3 + 0.6 * p[EFFORT];
        g.chaos = p[ROUGH];
        let pharynx = fill_areas(a.pharynx, |_| 0.65, &mut a.phar_area);
        a.net.set_tube_targets(a.pharynx, pharynx, None, None);
        // Raising the mandible narrows the distal oral tract. A residual aperture keeps this
        // oral-only prototype vocalising; a sealed nasal /m/ onset is outside this model.
        let aperture = 0.035 + 1.4 * p[JAW] * p[JAW];
        let oral = fill_areas(
            a.oral,
            |u| 1.1 + (aperture - 1.1) * smoothstep(0.4, 0.95, u),
            &mut a.oral_area,
        );
        a.net.set_tube_targets(a.oral, oral, None, None);
        mammal_noise(a, 3e-7, None);
    }

    #[inline]
    fn sample(&mut self) -> f64 {
        step_glottis(&mut self.a);
        self.a.net.step()
    }

    fn source_state(&self, out: &mut Vec<(&'static str, f64)>) {
        out.clear();
        out.push(("glottis", js_min(1.0, self.a.glottis_src.area / 0.06)));
        out.push(("f0", self.a.glottis_src.f0_now));
    }
}

fn def() -> CreatureDef {
    let k = CallKey::new;
    CreatureDef {
        id: "cat",
        name: "Domestic cat prototype",
        latin: "Felis catus",
        group: CreatureGroup::Mammal,
        blurb: "An oral meow prototype with an 8 cm tract and a moving jaw. Listening validation pending.",
        role: "Expressive meows",
        oversample: 4,
        gate_times: Some(GateTimes { attack: 0.012, release: 0.035 }),
        params: vec![
            ParamDef::new("pitch", "Pitch", 180.0, 1400.0, 550.0).unit("Hz").log().smooth(0.012).pitch(),
            ParamDef::new("jaw", "Jaw opening", 0.0, 1.0, 0.5).smooth(0.025),
            ParamDef::new("effort", "Vocal effort", 0.0, 1.0, 0.6).smooth(0.02),
            ParamDef::new("rough", "Roughness", 0.0, 0.35, 0.06).smooth(0.03),
            ParamDef::new("pressure", "Breath pressure", 3.0, 14.0, 7.0).unit("cmH2O").smooth(0.015),
        ],
        calls: vec![CallDef::new("meow", "Meow", "Jaw opens then closes while pitch arches and falls", Some(550.0), vec![
            k(0.0, &[("gate", 0.35), ("pitch", 440.0), ("jaw", 0.07)]),
            k(0.10, &[("gate", 1.0), ("pitch", 620.0), ("jaw", 0.72)]),
            k(0.24, &[("gate", 1.0), ("pitch", 690.0), ("jaw", 0.9)]).curve(Curve::Exp),
            k(0.62, &[("gate", 0.85), ("pitch", 480.0), ("jaw", 0.22)]).curve(Curve::Exp),
            k(0.80, &[("gate", 0.55), ("pitch", 370.0), ("jaw", 0.04)]).curve(Curve::Exp),
            k(0.86, &[("gate", 0.0)]),
        ])],
        events: vec![],
        create,
    }.resolved()
}
