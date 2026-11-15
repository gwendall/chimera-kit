//! Splitting a held vowel changes its pitch contour, not the word's articulation.
use chimera::control::score::{ControlKey, Gesture};
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::sing::{SongOptions, SungNote, midi_to_hz, plan_song};
use chimera::phonetics::syllables::lyrics_to_syllables;
use chimera::phonetics::Plan;

fn oral_vowels(p: &Plan) -> Vec<Gesture> {
    p.gestures.iter().filter(|g| g.label.as_ref().is_some_and(|label|
        p.segments.iter().any(|s| s.kind=="vowel" && s.ipa==label.as_str())
    )).copied().collect()
}

fn render_plan(parts: usize, varying_pitch: bool) -> Plan {
    let mut g = EnglishG2P::new();
    g.load_dict("bop\tB AA1 P\ndee\tD IY1\nbye\tB AY1\n");
    let text = format!("bop{} dee", " ~".repeat(parts - 1));
    let syllables = lyrics_to_syllables(&text, &g);
    let notes: Vec<_> = syllables.into_iter().enumerate().map(|(i, syl)| SungNote {
        midi: if i == parts { 64.0 } else if varying_pitch { 60.0 + i as f64 } else { 60.0 },
        beats: if i == parts { 1.0 } else { 1.0 / parts as f64 },
        syl,
    }).collect();
    plan_song(&notes, &SongOptions { body: "male".into(), bpm: 120.0, t0: 0.5, vibrato: 0.0 })
}

#[test]
fn a_subdivided_vowel_keeps_its_coda_and_the_next_onset() {
    let baseline = render_plan(1, false);
    let divided = render_plan(10, false);
    let consonants = |p: &Plan| p.segments.iter().filter(|s| s.kind != "vowel").map(|s| (s.ipa.clone(), s.t0, s.t1)).collect::<Vec<_>>();
    let a = consonants(&baseline);
    let b = consonants(&divided);
    assert_eq!(a.len(), b.len());
    for (expected, got) in a.iter().zip(&b) {
        assert_eq!(expected.0, got.0);
        assert!((expected.1 - got.1).abs() < 1e-9 && (expected.2 - got.2).abs() < 1e-9,
            "{} changed from {:.4}-{:.4} to {:.4}-{:.4} when its preceding vowel was subdivided", expected.0, expected.1, expected.2, got.1, got.2);
    }
}

#[test]
fn one_sustained_vowel_remains_one_articulatory_segment() {
    let a = render_plan(1, false);
    let b = render_plan(10, false);
    let av = oral_vowels(&a);
    let bv = oral_vowels(&b);
    assert_eq!(av.len(),2);
    assert_eq!(av.len(), bv.len(), "pitch subdivisions added oral gestures");
    for (a,b) in av.iter().zip(&bv) {
        assert_eq!(a.label,b.label);
        assert!((a.t0-b.t0).abs()<1e-9 && (a.t1-b.t1).abs()<1e-9);
    }
}

#[test]
fn pitch_can_move_inside_a_single_articulated_vowel() {
    let plan = render_plan(5, true);
    let vowel = oral_vowels(&plan)[0];
    for i in 1..4 {
        let time = 0.5 + i as f64 * 0.1;
        assert!(time < vowel.t1);
        assert!(plan.gestures.iter().any(|g| (g.t0-time).abs()<1e-9 && g.targets.get(ControlKey::F0)==Some(midi_to_hz(60.0+i as f64))),
            "missing independent pitch change at {time}");
    }
}

#[test]
fn final_diphthongs_and_the_breath_keep_their_timing() {
    let mut g = EnglishG2P::new();
    g.load_dict("bye\tB AY1\n");
    let make = |parts: usize| {
        let syllables = lyrics_to_syllables(&format!("bye{}", " ~".repeat(parts - 1)), &g);
        let notes: Vec<_> = syllables.into_iter().map(|syl| SungNote { midi: 60.0, beats: 1.0 / parts as f64, syl }).collect();
        plan_song(&notes, &SongOptions { body: "male".into(), bpm: 120.0, t0: 0.5, vibrato: 0.0 })
    };
    let baseline = make(1);
    for parts in [2, 5, 10, 20] {
        let divided = make(parts);
        let a = oral_vowels(&baseline);
        let b = oral_vowels(&divided);
        assert_eq!(a.len(),2);
        assert_eq!(a.len(), b.len());
        for (a,b) in a.iter().zip(&b) {
            assert_eq!(a.label,b.label);
            assert!((a.t0-b.t0).abs()<1e-9 && (a.t1-b.t1).abs()<1e-9, "{parts} pitch slices moved a vowel gesture");
        }
        assert!((baseline.end-divided.end).abs()<1e-9, "{parts} pitch slices moved the breath");
    }
}

#[test]
fn vowel_metadata_still_identifies_each_sung_pitch_interval() {
    let plan = render_plan(3, true);
    let starts: Vec<_> = plan.segments.iter().filter(|s| s.kind=="vowel").map(|s|s.t0).collect();
    assert_eq!(starts.len(),4);
    for (got,want) in starts.iter().zip([0.5,0.5+1.0/6.0,0.5+1.0/3.0,1.0]) {
        assert!((got-want).abs()<1e-9);
    }
}

#[test]
fn diphthong_metadata_keeps_each_notes_actual_start() {
    let mut g = EnglishG2P::new();
    g.load_dict("bye\tB AY1\n");
    let syllables = lyrics_to_syllables("bye ~ ~ ~ ~", &g);
    let notes: Vec<_> = syllables.into_iter().map(|syl| SungNote { midi: 60.0, beats: 0.2, syl }).collect();
    let plan = plan_song(&notes, &SongOptions { body: "male".into(), bpm: 120.0, t0: 0.5, vibrato: 0.0 });
    let vowels: Vec<_> = plan.segments.iter().filter(|s| s.kind=="vowel").collect();
    assert_eq!(vowels.len(),6);
    for (i,vowel) in vowels.iter().take(5).enumerate() {
        assert!((vowel.t0-(0.5+i as f64*0.1)).abs()<1e-9);
    }
    assert!(vowels.iter().all(|s| s.t1>s.t0 && s.t0>=0.5 && s.t1<=0.95+1e-9));
}

#[test]
fn a_voiced_coda_keeps_following_the_pitch_contour() {
    let mut g = EnglishG2P::new();
    g.load_dict("boom\tB UW1 M\ndee\tD IY1\n");
    let syllables = lyrics_to_syllables("boom ~ ~ ~ ~ dee", &g);
    let notes: Vec<_> = syllables.into_iter().enumerate().map(|(i,syl)| SungNote {
        midi: 60.0+i as f64,
        beats: if i<5 { 0.2 } else { 1.0 },
        syl,
    }).collect();
    let plan = plan_song(&notes, &SongOptions { body: "male".into(), bpm: 120.0, t0: 0.5, vibrato: 0.0 });
    let coda = plan.segments.iter().find(|s| s.ipa=="m").unwrap();
    assert!(coda.t0<0.9 && coda.t1>0.9);
    assert!(plan.gestures.iter().any(|g| (g.t0-0.9).abs()<1e-9 && g.targets.get(ControlKey::F0)==Some(midi_to_hz(64.0))),
        "the last pitch change was lost because the tongue had reached the coda");
}
