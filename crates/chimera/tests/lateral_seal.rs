//! A prepared central-consonant gesture must close a previously open lateral passage.
use chimera::anatomy::human::{ArticKey, ArticPatch};
use chimera::control::articulators::ArticulatorBank;

#[test]
fn a_prepared_lateral_seal_reaches_contact_in_finite_time() {
    let mut bank = ArticulatorBank::new();
    bank.snap(&ArticPatch::default().with(ArticKey::Lateral, 0.8));
    bank.set_target(&ArticPatch::default().with(ArticKey::Lateral, -0.1));
    for _ in 0..100 {
        bank.step(0.001, None, 1.0);
    }
    assert!(
        bank.x.lateral <= 0.0,
        "side passage still open: {}",
        bank.x.lateral
    );
}
