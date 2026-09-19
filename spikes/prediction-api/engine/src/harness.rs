//! Tiny in-process host <-> client loop with a per-client one-way delay measured in ticks.

use crate::*;

pub struct Link<G: Game> {
    pub client: Client<G>,
    pub delay: u32,
    up: VecDeque<(u64, u32, G::Action)>,
    down: VecDeque<(u64, Frame<G>)>,
}

pub struct Sim<G: Game> {
    pub host: Host<G>,
    pub links: Vec<Link<G>>,
    pub now: u64,
}

impl<G: Game> Sim<G> {
    pub fn new(cfg: G::Config) -> Self {
        Sim { host: Host::new(cfg), links: Vec::new(), now: 0 }
    }

    /// Returns the client's index. `lead` defaults to the exact value for this harness (2*delay+1).
    pub fn add_client(&mut self, cfg: G::Config, who: PlayerId, delay: u32, subs: &[ChunkCoord]) -> usize {
        self.host.connect(who);
        for c in subs {
            self.host.subscribe(who, *c);
        }
        self.links.push(Link { client: Client::new(cfg, who, 2 * delay + 1), delay, up: VecDeque::new(), down: VecDeque::new() });
        self.links.len() - 1
    }

    pub fn client(&mut self, i: usize) -> &mut Client<G> {
        &mut self.links[i].client
    }

    /// One host tick: deliver due uplink, step the host, deliver due frames.
    pub fn step(&mut self) {
        self.now += 1;
        let now = self.now;
        for l in &mut self.links {
            for (seq, a) in l.client.outbox.drain(..) {
                l.up.push_back((now + l.delay as u64, seq, a));
            }
        }
        // Arrival order across clients: by due time, then client index (the host is the sequencer).
        for l in &mut self.links {
            while l.up.front().is_some_and(|(due, _, _)| *due <= now) {
                let (_, seq, a) = l.up.pop_front().unwrap();
                self.host.receive(l.client.who, seq, a);
            }
        }
        for (who, frame) in self.host.step() {
            let l = self.links.iter_mut().find(|l| l.client.who == who).unwrap();
            l.down.push_back((now + l.delay as u64, frame));
        }
        for l in &mut self.links {
            while l.down.front().is_some_and(|(due, _)| *due <= now) {
                let (_, f) = l.down.pop_front().unwrap();
                l.client.on_frame(&f);
            }
        }
    }

    pub fn run(&mut self, steps: u32) {
        for _ in 0..steps {
            self.step();
        }
    }
}
