use engine::Game;

pub const BIAS: i32 = 0; // devloop.mjs rewrites this line

pub struct MyGame {
    state: u32,
    cells: Vec<u32>,
}

impl Game for MyGame {
    fn new(seed: u32) -> Self {
        MyGame { state: seed, cells: vec![0; 1024] }
    }
    fn tick(&mut self) {
        // xorshift32 + touch some heap so the allocator is linked in.
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.state = x;
        let i = (x as usize) % self.cells.len();
        self.cells[i] = self.cells[i].wrapping_add(x);
    }
    fn state_hash(&self) -> u32 {
        self.cells.iter().fold(self.state, |h, c| h.rotate_left(5) ^ c)
    }
    fn add(&self, a: i32, b: i32) -> i32 {
        if a == i32::MIN {
            panic!("deliberate panic from game code");
        }
        a + b + BIAS
    }
}

engine::export_game!(MyGame);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_test_via_rlib() {
        let g = MyGame::new(1);
        assert_eq!(g.add(40, 2), 42 + BIAS);
    }
}
