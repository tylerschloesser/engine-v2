We are going to attempt to add belts to the reference game.
Belts are going to introduce immense complexity, more than likely. So we need to do extensive research and prototyping.
I want to add belts in an as compute-efficient manner as possible.
Factorio is the inspiration, but Factorio's complexity is likely too much. So we likely need a simpler version of Factorio belts.

First, belts are likely to require being in the engine, rather than the reference game. Find the right abstraction to put as little in the engine as possible allowing as much flexibility as possible. For example, we are likely going to need to "chunk" items moving across the same belt at the same speed so we don't have to update every single item per tick. W.r.t what the reference game cares about. Reference game might want to offer different belt speeds.
Splitters and undergrounds are required.

Belt rendering needs to be smart. Consider that belts are essentially a network, and can span a super large space. Much larger than the viewport. Ideally the simulation would aid in prediction - because the client probably won't be able to very accurately.

The exact design and parameters might need to be verified emperically. To that end, the plan can include some prototyping and automated testing on real browsers & phones.

Plan should be broken into phases. Ideally a single Opus or Fable manager session delegating complex tasks to Opus sub-agents and simpler tasks to Sonnet or even Haiku.

Goal of this session is to design a PLAN.md file we can have a single manager session execute in a very long running session. The plan doesn't need to specify every final detail. Break it into phases and we can assume that intermediate phases will refine the final implementation based on research and emperical measurements. The plan execution shoudl be capable of revising mid-plan.

Commit early and often. Commit to main. Push early and often and verify CI. Adversarial review commits or small series of commits frequently. Revise shared context aggressively.

Make trivial decisions yourself. Solicit feedback from me early and often for non-trivial decisions.

Performance is critical. Belts need to be implemented to very carefully balance sophistication (lots of items, splitter logic, side-loading, etc. etc.) and speed (minimal/no-gc, network streaming and prediction + resolution).

For the initial implementation, we can decouple belts from the existing furnace entity. Let's have two special belts to aid in testing: spawner and despawner. Spawner will automatically spawn items at a specified rate - they enter at the "back" of the belt (input side). Despawner is the opposite. They simpler remove everything that hits the end/output side. Use the existing resources we have as items: coal, iron, wood, etc. Use placeholder art/simple squares (with borders, for better contrast).

Near the end, build and test complex belt scenarios for verification.

We want to keep Factorio's two-lane belt model. Note our default tick rate is 20hz. Factorio's is 60hz. We'll need to take that into consideration.

---
I have a prior project that successfully reverse engineer factorio belts and re-used Factorio assets for rendering. I didn't test it extensively, but the basic belt mechanics worked perfectly as far as I could tell. Use for reference/inspiration - code is not transferable:
/Users/tyler/repos/belt
