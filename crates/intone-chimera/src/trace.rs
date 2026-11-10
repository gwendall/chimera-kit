//! Optional drawing data copied from the already-computed engine state, never recomputed.
use chimera::voice::human_voice::HumanVoice;

pub(crate) fn append_geometry(voice: &HumanVoice, out: &mut Vec<f32>) {
    let body = voice.airway.body;
    let frame = voice.airway.frame.as_ref();
    out.extend([1.0, if frame.is_some() { 1.0 } else { 0.0 }]);
    out.extend(voice.artic.x.to_array().map(|x| x as f32));
    out.extend([body.scale, body.pharynx, body.tongue_radius, body.lip_width].map(|x| x as f32));
    let Some(f) = frame else { return };
    let outlines = [
        &f.outer,
        &f.inner,
        &f.tongue,
        &f.velum,
        &f.upper_lip,
        &f.lower_lip,
        &f.upper_teeth,
        &f.lower_teeth,
        &f.jaw_bone,
        &f.epiglottis,
        &f.nasal_cavity,
    ];
    out.extend(outlines.iter().map(|v| v.len() as f32));
    out.push(f.grid.len() as f32);
    out.extend(
        [
            f.glottis.x,
            f.glottis.y,
            f.length,
            f.pharynx_length,
            f.teeth_s,
            f.lip_s,
            f.velum_port,
            f.lip_area,
            f.tongue_center.x,
            f.tongue_center.y,
            f.tongue_radius,
            f.tip.x,
            f.tip.y,
            f.split_index as f64,
        ]
        .map(|x| x as f32),
    );
    for points in outlines {
        out.extend(points.iter().flat_map(|p| [p.x as f32, p.y as f32]));
    }
    for g in &f.grid {
        out.extend(
            [
                g.inner.x,
                g.inner.y,
                g.outer.x,
                g.outer.y,
                g.mid.x,
                g.mid.y,
                g.d,
                g.area,
                g.s,
                f64::from(g.region),
                g.ray,
            ]
            .map(|x| x as f32),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chimera::anatomy::human::BODY_FEMALE;

    #[test]
    fn geometry_is_the_retained_frame_and_current_articulation() {
        let mut voice = HumanVoice::new(48_000.0, BODY_FEMALE, 2);
        voice.render(&mut [0.0; 128]);
        let mut data = Vec::new();
        append_geometry(&voice, &mut data);
        assert_eq!(&data[..2], &[1.0, 1.0]);
        assert_eq!(&data[2..19], &voice.artic.x.to_array().map(|x| x as f32));
        assert_eq!(&data[19..23], &[0.9, 0.88, 2.2, 4.4]);
        let f = voice.airway.frame.as_ref().unwrap();
        assert_eq!(data[23] as usize, f.outer.len());
        assert_eq!(data[34] as usize, f.grid.len());
        assert_eq!(&data[35..37], &[f.glottis.x as f32, f.glottis.y as f32]);
        let original: Vec<f32> = f
            .outer
            .iter()
            .flat_map(|p| [p.x as f32, p.y as f32])
            .collect();
        assert_eq!(&data[49..49 + original.len()], &original);
    }
}
