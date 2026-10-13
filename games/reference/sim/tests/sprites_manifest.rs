//! `content::SPRITE_*` against the generated atlas manifest (`assets/sprites.json`, written by
//! `scripts/gen-assets.mjs`, M51): every belt id (five families of three facings) has
//! `SPRITE_BELT_FRAMES` frames, size 1 x 1 and pivot [0, 0], and its art is that family's and
//! facing's (the generator's `name`, `belt/<family>/<facing>`; rows sit in id order); every item square (`SPRITE_ITEM_FIRST + ItemId`) is one frame,
//! half a tile, centred. Fails if the Rust ids and the generator's layout drift apart.

use reference_sim::content;
use serde_json::Value;

fn manifest() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../assets/sprites.json");
    let text = std::fs::read_to_string(path).expect("assets/sprites.json");
    serde_json::from_str(&text).expect("valid JSON")
}

fn sprite(m: &Value, id: u16) -> &Value {
    m["sprites"]
        .get(id.to_string())
        .unwrap_or_else(|| panic!("sprite {id} is in the manifest"))
}

fn nums(v: &Value) -> Vec<f64> {
    v.as_array()
        .expect("an array")
        .iter()
        .map(|x| x.as_f64().expect("a number"))
        .collect()
}

#[test]
fn sprite_ids_match_the_manifest() {
    let m = manifest();
    let furnace = sprite(&m, content::SPRITE_FURNACE);
    assert_eq!(furnace["name"], "furnace");
    assert_eq!(furnace["frames"], 2);
    assert_eq!(nums(&furnace["size"]), [2.0, 2.0]);

    let families = [
        (content::SPRITE_BELT_STRAIGHT, "straight"),
        (content::SPRITE_BELT_CURVE_LEFT, "curveLeft"),
        (content::SPRITE_BELT_CURVE_RIGHT, "curveRight"),
        (content::SPRITE_BELT_SPAWNER, "spawner"),
        (content::SPRITE_BELT_DESPAWNER, "despawner"),
    ];
    let facings = ["east", "south", "north"];
    // The generator lays one strip per row in id order: ids rise with the rect's y.
    let mut last_y = nums(&furnace["rect"])[1];
    for (f, (family, family_name)) in families.into_iter().enumerate() {
        for facing in 0..3u16 {
            let id = family + facing;
            assert_eq!(id, 1 + f as u16 * 3 + facing, "family {f} facing {facing}");
            let s = sprite(&m, id);
            let name = format!("belt/{family_name}/{}", facings[usize::from(facing)]);
            assert_eq!(s["name"], name.as_str(), "sprite {id}'s art");
            assert_eq!(
                s["frames"],
                content::SPRITE_BELT_FRAMES,
                "sprite {id} frames"
            );
            assert_eq!(nums(&s["size"]), [1.0, 1.0], "sprite {id} size");
            assert_eq!(nums(&s["pivot"]), [0.0, 0.0], "sprite {id} pivot");
            let rect = nums(&s["rect"]);
            assert_eq!(
                (rect[2], rect[3]),
                (16.0, 16.0),
                "sprite {id}: one 16 px tile"
            );
            assert!(rect[1] > last_y, "sprite {id}: rows in id order");
            last_y = rect[1];
        }
    }
    let items = [
        (content::ItemId::Stone, "stone"),
        (content::ItemId::Iron, "iron"),
        (content::ItemId::Wood, "wood"),
        (content::ItemId::Coal, "coal"),
        (content::ItemId::Furnace, "furnace"),
        (content::ItemId::Ingot, "ingot"),
    ];
    assert_eq!(items.len(), content::ITEM_COUNT);
    for (item, item_name) in items {
        let id = content::SPRITE_ITEM_FIRST + item as u16;
        let s = sprite(&m, id);
        let name = format!("item/{item_name}");
        assert_eq!(s["name"], name.as_str(), "item sprite {id}'s art");
        assert_eq!(s["frames"], 1, "item sprite {id} frames");
        assert_eq!(nums(&s["size"]), [0.5, 0.5], "item sprite {id} size");
        assert_eq!(nums(&s["pivot"]), [0.5, 0.5], "item sprite {id} pivot");
    }
    let count = m["sprites"].as_object().expect("an object").len();
    assert_eq!(
        count,
        usize::from(content::SPRITE_ITEM_FIRST) + content::ITEM_COUNT,
        "no other sprite"
    );
}
