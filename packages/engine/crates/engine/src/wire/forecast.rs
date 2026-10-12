//! `Forecasts` (section 13, M47, docs/decisions/0078 A3): a held line's motion as forecasts the
//! host corrects only when wrong. Three record kinds, each a `tag u8` then its fields, in kind
//! order `State`, `Arrival`, `RunList` (the small ones never wait behind a long list), lines
//! ascending within a kind; byte layout in `wire/CLAUDE.md` (its single home).
//!
//! What each record means to the replica (`transport/follow.rs`), all at the frame's tick `T`:
//! - [`State`]: before the client steps `T`, the items it holds on the line (its `T - 1` list)
//!   take the stops `front_stop + SPACING x k`, `k` counted from the front (none without a stop);
//!   `paused`/`resumed` stop or restart the line's spawner replay.
//! - [`RunList`]: the line's whole list, replaced: the client empties the line before it steps
//!   `T` (its items neither move nor cross during `T`) and afterwards holds exactly these runs,
//!   each with its own stop, and this spawner schedule (none: the line has no spawner). An
//!   `unknown` list (a list too large for a frame's put budget) leaves the line empty and its
//!   items unknown until a full list comes.
//! - [`Arrival`]: after the step, an item the client did not move there itself (it came from a
//!   line the client does not hold, across a `Fork`, or from a line replaced this tick), at `pos`
//!   with `stop`.
//!
//! Allocation-free both ways: the writers take plain values and a `ByteSink`; the reader borrows
//! and hands each record to a callback, a run list's runs as a [`Runs`] cursor over its own
//! (already validated) bytes. Malformed: an unknown tag, truncation, a line id 0, an item 0, flag
//! bits not defined (an `unknown` list has no other bit), `paused` with `resumed`, a run with `count` 0, run positions not strictly
//! increasing within a list (a run's first item past the previous run's last), a spawner period 0,
//! kinds out of order, lines not ascending within `State` and `RunList`, `(line, pos)` not
//! ascending within `Arrival`.

use crate::bytes::{ByteReader, ByteSink};
use crate::transport::{Item, LineId, SPACING};

use super::{WireError, varint_u32};

const TAG_STATE: u8 = 0;
const TAG_ARRIVAL: u8 = 1;
const TAG_RUN_LIST: u8 = 2;

const STATE_HAS_STOP: u8 = 1;
const STATE_PAUSED: u8 = 2;
const STATE_RESUMED: u8 = 4;
const ARRIVAL_HAS_STOP: u8 = 1;
const LIST_HAS_SPAWNER: u8 = 1;
const LIST_UNKNOWN: u8 = 2;
const SPAWNER_PAUSED: u8 = 1;
/// A run's stop on the wire when it has none (a stop is never `i32::MIN`: the tracker clamps).
pub const NO_STOP: i32 = i32::MIN;

/// A correction of a line's motion (module doc).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct State {
    pub line: LineId,
    pub front_stop: Option<i32>,
    pub paused: bool,
    pub resumed: bool,
}

/// An item entering a held line by a route the client does not follow (module doc).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Arrival {
    pub line: LineId,
    pub item: Item,
    pub pos: u32,
    pub stop: Option<i32>,
}

/// A line's spawner as the client replays it (`transport::Schedule` plus its paused flag).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Spawner {
    pub period: u32,
    pub acc: u32,
    pub kinds: u16,
    pub next: Item,
    pub paused: bool,
}

/// One run of a run list: `count` items of `item`, `SPACING` apart from `pos`, item `k` stopping
/// at `stop + SPACING x k` (none: free).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Run {
    pub item: Item,
    pub count: u16,
    pub pos: u32,
    pub stop: Option<i32>,
}

/// A run list as read: its line, spawner and a cursor over its runs.
#[derive(Clone, Copy, Debug)]
pub struct RunList<'a> {
    pub line: LineId,
    /// The line's items are not sent (its list is larger than a frame's put budget): the client
    /// holds the structure and no items, and ignores states and arrivals for it until a list
    /// comes. No runs, no spawner.
    pub unknown: bool,
    pub spawner: Option<Spawner>,
    pub runs: Runs<'a>,
}

/// The runs of a validated run list, front to back.
#[derive(Clone, Copy, Debug)]
pub struct Runs<'a> {
    bytes: &'a [u8],
    left: u32,
}

impl Runs<'_> {
    pub fn len(&self) -> u32 {
        self.left
    }

    pub fn is_empty(&self) -> bool {
        self.left == 0
    }
}

impl Iterator for Runs<'_> {
    type Item = Run;
    fn next(&mut self) -> Option<Run> {
        if self.left == 0 {
            return None;
        }
        let mut r = ByteReader::new(self.bytes);
        let run = read_run(&mut r).ok()?;
        self.bytes = r.rest();
        self.left -= 1;
        Some(run)
    }
}

/// One record as read.
#[derive(Clone, Copy, Debug)]
pub enum Record<'a> {
    State(State),
    Arrival(Arrival),
    RunList(RunList<'a>),
}

fn stop_bits(stop: Option<i32>) -> i32 {
    stop.unwrap_or(NO_STOP)
}

pub fn write_state(sink: &mut (impl ByteSink + ?Sized), s: &State) {
    sink.put_u8(TAG_STATE);
    sink.put_varint(u64::from(s.line.0));
    let mut flags = 0;
    if s.front_stop.is_some() {
        flags |= STATE_HAS_STOP;
    }
    if s.paused {
        flags |= STATE_PAUSED;
    }
    if s.resumed {
        flags |= STATE_RESUMED;
    }
    sink.put_u8(flags);
    if let Some(fs) = s.front_stop {
        sink.put_i32(fs);
    }
}

pub fn write_arrival(sink: &mut (impl ByteSink + ?Sized), a: &Arrival) {
    sink.put_u8(TAG_ARRIVAL);
    sink.put_varint(u64::from(a.line.0));
    sink.put_u16(a.item.0);
    sink.put_u32(a.pos);
    match a.stop {
        Some(s) => {
            sink.put_u8(ARRIVAL_HAS_STOP);
            sink.put_i32(s);
        }
        None => sink.put_u8(0),
    }
}

/// A run list's header: `runs` runs follow ([`write_run`]), then [`write_spawner`] if `spawner`.
pub fn write_run_list_header(
    sink: &mut (impl ByteSink + ?Sized),
    line: LineId,
    spawner: bool,
    runs: u32,
) {
    sink.put_u8(TAG_RUN_LIST);
    sink.put_varint(u64::from(line.0));
    sink.put_u8(if spawner { LIST_HAS_SPAWNER } else { 0 });
    sink.put_varint(u64::from(runs));
}

pub fn write_run(sink: &mut (impl ByteSink + ?Sized), r: &Run) {
    sink.put_u16(r.item.0);
    sink.put_u16(r.count);
    sink.put_u32(r.pos);
    sink.put_i32(stop_bits(r.stop));
}

pub fn write_spawner(sink: &mut (impl ByteSink + ?Sized), s: &Spawner) {
    sink.put_varint(u64::from(s.period));
    sink.put_varint(u64::from(s.acc));
    sink.put_u16(s.kinds);
    sink.put_u16(s.next.0);
    sink.put_u8(if s.paused { SPAWNER_PAUSED } else { 0 });
}

/// A run list saying the line's items are unknown ([`RunList::unknown`]).
pub fn write_run_list_unknown(sink: &mut (impl ByteSink + ?Sized), line: LineId) {
    sink.put_u8(TAG_RUN_LIST);
    sink.put_varint(u64::from(line.0));
    sink.put_u8(LIST_UNKNOWN);
}

/// A whole run list from a slice (tests and tools; the host writes from the store).
pub fn write_run_list(
    sink: &mut (impl ByteSink + ?Sized),
    line: LineId,
    runs: &[Run],
    spawner: Option<&Spawner>,
) {
    write_run_list_header(sink, line, spawner.is_some(), runs.len() as u32);
    for r in runs {
        write_run(sink, r);
    }
    if let Some(s) = spawner {
        write_spawner(sink, s);
    }
}

fn line_id(r: &mut ByteReader) -> Result<LineId, WireError> {
    let id = varint_u32(r)?;
    if id == 0 {
        return Err(WireError::Malformed);
    }
    Ok(LineId(id))
}

fn item(r: &mut ByteReader) -> Result<Item, WireError> {
    let v = r.u16().map_err(WireError::from)?;
    if v == 0 {
        return Err(WireError::Malformed);
    }
    Ok(Item(v))
}

fn read_run(r: &mut ByteReader) -> Result<Run, WireError> {
    let item = item(r)?;
    let count = r.u16().map_err(WireError::from)?;
    let pos = r.u32().map_err(WireError::from)?;
    let stop = r.i32().map_err(WireError::from)?;
    if count == 0 {
        return Err(WireError::Malformed);
    }
    Ok(Run {
        item,
        count,
        pos,
        stop: (stop != NO_STOP).then_some(stop),
    })
}

fn read_spawner(r: &mut ByteReader) -> Result<Spawner, WireError> {
    let period = varint_u32(r)?;
    let acc = varint_u32(r)?;
    let kinds = r.u16().map_err(WireError::from)?;
    let next = item(r)?;
    let flags = r.u8().map_err(WireError::from)?;
    if period == 0 || flags & !SPAWNER_PAUSED != 0 {
        return Err(WireError::Malformed);
    }
    Ok(Spawner {
        period,
        acc,
        kinds,
        next,
        paused: flags & SPAWNER_PAUSED != 0,
    })
}

/// Reads a whole `Forecasts` body, `f` per record in order (module doc for what is malformed).
pub fn read(r: &mut ByteReader, mut f: impl FnMut(Record<'_>)) -> Result<(), WireError> {
    // The last record's kind and its ordering key.
    let mut last: Option<(u8, u32, u32)> = None;
    while !r.rest().is_empty() {
        let tag = r.u8().map_err(WireError::from)?;
        let line = line_id(r)?;
        let key = match tag {
            TAG_STATE => {
                let flags = r.u8().map_err(WireError::from)?;
                if flags & !(STATE_HAS_STOP | STATE_PAUSED | STATE_RESUMED) != 0
                    || flags & (STATE_PAUSED | STATE_RESUMED) == STATE_PAUSED | STATE_RESUMED
                {
                    return Err(WireError::Malformed);
                }
                let front_stop = if flags & STATE_HAS_STOP != 0 {
                    Some(r.i32().map_err(WireError::from)?)
                } else {
                    None
                };
                check_order(&mut last, (tag, line.0, 0))?;
                f(Record::State(State {
                    line,
                    front_stop,
                    paused: flags & STATE_PAUSED != 0,
                    resumed: flags & STATE_RESUMED != 0,
                }));
                continue;
            }
            TAG_ARRIVAL => {
                let item = item(r)?;
                let pos = r.u32().map_err(WireError::from)?;
                let flags = r.u8().map_err(WireError::from)?;
                if flags & !ARRIVAL_HAS_STOP != 0 {
                    return Err(WireError::Malformed);
                }
                let stop = if flags & ARRIVAL_HAS_STOP != 0 {
                    Some(r.i32().map_err(WireError::from)?)
                } else {
                    None
                };
                check_order(&mut last, (tag, line.0, pos))?;
                f(Record::Arrival(Arrival {
                    line,
                    item,
                    pos,
                    stop,
                }));
                continue;
            }
            TAG_RUN_LIST => (tag, line.0, 0),
            _ => return Err(WireError::Malformed),
        };
        let flags = r.u8().map_err(WireError::from)?;
        if flags == LIST_UNKNOWN {
            check_order(&mut last, key)?;
            f(Record::RunList(RunList {
                line,
                unknown: true,
                spawner: None,
                runs: Runs {
                    bytes: &[],
                    left: 0,
                },
            }));
            continue;
        }
        if flags & !LIST_HAS_SPAWNER != 0 {
            return Err(WireError::Malformed);
        }
        let n = varint_u32(r)?;
        let start = r.rest();
        // Positions strictly increase across the list: a run's first item past the last one's.
        let mut last_pos: Option<u64> = None;
        for _ in 0..n {
            let run = read_run(r)?;
            let first = u64::from(run.pos);
            if last_pos.is_some_and(|p| first <= p) {
                return Err(WireError::Malformed);
            }
            last_pos = Some(first + u64::from(SPACING) * (u64::from(run.count) - 1));
        }
        let runs_len = start.len() - r.rest().len();
        let spawner = if flags & LIST_HAS_SPAWNER != 0 {
            Some(read_spawner(r)?)
        } else {
            None
        };
        check_order(&mut last, key)?;
        f(Record::RunList(RunList {
            line,
            unknown: false,
            spawner,
            runs: Runs {
                bytes: &start[..runs_len],
                left: n,
            },
        }));
    }
    Ok(())
}

/// Kinds in order, then ascending keys within a kind (strictly: `(line, pos)` for arrivals,
/// `line` for the others).
fn check_order(last: &mut Option<(u8, u32, u32)>, key: (u8, u32, u32)) -> Result<(), WireError> {
    if let Some(prev) = *last
        && key <= prev
    {
        return Err(WireError::Malformed);
    }
    *last = Some(key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bytes::SliceSink;

    #[test]
    fn golden_forecasts() {
        let mut buf = [0u8; 256];
        let mut sink = SliceSink::new(&mut buf);
        let st = |line, front_stop, paused, resumed| State {
            line: LineId(line),
            front_stop,
            paused,
            resumed,
        };
        // M47 review (finding 11): every flag both ways and an unknown list.
        write_state(&mut sink, &st(3, Some(-128), true, false));
        write_state(&mut sink, &st(6, None, false, true));
        let arr = |line, item, pos, stop| Arrival {
            line: LineId(line),
            item: Item(item),
            pos,
            stop,
        };
        write_arrival(&mut sink, &arr(4, 2, 1000, None));
        write_arrival(&mut sink, &arr(7, 3, 640, Some(-64)));
        write_run_list(
            &mut sink,
            LineId(5),
            &[Run {
                item: Item(1),
                count: 3,
                pos: 64,
                stop: Some(0),
            }],
            Some(&Spawner {
                period: 512,
                acc: 256,
                kinds: 6,
                next: Item(2),
                paused: false,
            }),
        );
        write_run_list(
            &mut sink,
            LineId(8),
            &[Run {
                item: Item(4),
                count: 1,
                pos: 10,
                stop: None,
            }],
            None,
        );
        write_run_list_unknown(&mut sink, LineId(9));
        let n = sink.finish().unwrap();
        let mut records = 0;
        read(&mut ByteReader::new(&buf[..n]), |_| records += 1).unwrap();
        assert_eq!(records, 7, "a valid section");
        crate::assert_golden_bytes!("wire_forecasts", &buf[..n]);
    }
}
