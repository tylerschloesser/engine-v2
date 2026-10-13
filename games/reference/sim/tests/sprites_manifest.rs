//! `content::SPRITE_*` against the generated atlas manifest (`assets/sprites.json`, written by
//! `scripts/gen-assets.mjs`, M51): every belt id (five families of three facings) has
//! `SPRITE_BELT_FRAMES` frames, size 1 x 1 and pivot [0, 0], and its art is that family's and
//! facing's (the generator's `name`, `belt/<family>/<facing>`; rows sit in id order); every item square (`SPRITE_ITEM_FIRST + ItemId`) is one frame,
//! half a tile, centred, the squares sharing one row; M54: the splitter sprites (`SPRITE_SPLITTER`
//! east, `+ 1` south, `+ 2` north) follow in rows of their own, `SPRITE_BELT_FRAMES` frames, pivot
//! [0, 0], 1 x 2 tiles facing east and 2 x 1 facing south and north; M55: the underground sprites
//! (`SPRITE_UNDERGROUND_IN` east, south, north, then `SPRITE_UNDERGROUND_OUT`'s three) follow, each
//! `SPRITE_BELT_FRAMES` frames, 1 x 1, pivot [0, 0], named `underground/<in|out>/<facing>`. Fails if the Rust ids and the
//! generator's layout drift apart.

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
    let items_row = last_y;
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
        let rect = nums(&s["rect"]);
        assert!(rect[1] > items_row, "item sprite {id}: below the belts");
        if item != content::ItemId::Stone {
            assert_eq!(
                rect[1], last_y,
                "item sprite {id}: the squares share one row"
            );
        }
        last_y = rect[1];
    }
    assert_eq!(
        content::SPRITE_SPLITTER,
        content::SPRITE_ITEM_FIRST + content::ITEM_COUNT as u16,
        "the splitters follow the items"
    );
    for (facing, name, size, px) in [
        (0u16, "east", [1.0, 2.0], (16.0, 32.0)),
        (1, "south", [2.0, 1.0], (32.0, 16.0)),
        (2, "north", [2.0, 1.0], (32.0, 16.0)),
    ] {
        let id = content::SPRITE_SPLITTER + facing;
        let s = sprite(&m, id);
        assert_eq!(
            s["name"],
            format!("splitter/{name}").as_str(),
            "sprite {id}'s art"
        );
        assert_eq!(
            s["frames"],
            content::SPRITE_BELT_FRAMES,
            "sprite {id} frames"
        );
        assert_eq!(nums(&s["size"]), size, "sprite {id} size");
        assert_eq!(nums(&s["pivot"]), [0.0, 0.0], "sprite {id} pivot");
        let rect = nums(&s["rect"]);
        assert_eq!((rect[2], rect[3]), px, "sprite {id}: 16 px a tile");
        assert!(rect[1] > last_y, "sprite {id}: rows in id order");
        last_y = rect[1];
    }
    assert_eq!(
        content::SPRITE_UNDERGROUND_IN,
        content::SPRITE_SPLITTER + 3,
        "the undergrounds follow the splitters"
    );
    assert_eq!(
        content::SPRITE_UNDERGROUND_OUT,
        content::SPRITE_UNDERGROUND_IN + 3,
        "the exits follow the entrances"
    );
    for (first, end) in [
        (content::SPRITE_UNDERGROUND_IN, "in"),
        (content::SPRITE_UNDERGROUND_OUT, "out"),
    ] {
        for (facing, name) in ["east", "south", "north"].into_iter().enumerate() {
            let id = first + facing as u16;
            let s = sprite(&m, id);
            assert_eq!(
                s["name"],
                format!("underground/{end}/{name}").as_str(),
                "sprite {id}'s art"
            );
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
    let count = m["sprites"].as_object().expect("an object").len();
    assert_eq!(
        count,
        usize::from(content::SPRITE_UNDERGROUND_OUT) + 3,
        "no other sprite"
    );
}
