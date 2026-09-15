const { randomUUID } = require("crypto");
const { getStateModel } = require("services/db");

// A renewable database lease protects each job across processes; local busy protects overlapping timers.
function schedule(name, interval, work) {
    let busy = false, stopped = false;
    const run = async () => {
        if (busy || stopped) return;
        busy = true;
        const owner = randomUUID(), model = getStateModel();
        let heartbeat, lost = false;
        const leaseMs = 120000;
        try {
            try { await model.updateOne({ _id: name }, { $setOnInsert: { leaseUntil: new Date(0) } }, { upsert: true }); }
            catch (error) { if (error.code !== 11000) throw error; }
            const lease = await model.findOneAndUpdate({ _id: name, leaseUntil: { $lte: new Date() } },
                { $set: { owner, leaseUntil: new Date(Date.now() + leaseMs) } }, { new: true }).lean();
            if (!lease) return;
            heartbeat = setInterval(async () => {
                try {
                    const result = await model.updateOne({ _id: name, owner }, { $set: { leaseUntil: new Date(Date.now() + leaseMs) } });
                    if (!result.matchedCount) lost = true;
                } catch (_) { lost = true; }
            }, 30000);
            const check = () => { if (lost || stopped) throw new Error(`${name} lease lost or stopping`); };
            await work(check);
        } catch (error) { console.error(`[${name}] ${error.message}`); }
        finally {
            clearInterval(heartbeat);
            await model.updateOne({ _id: name, owner }, { $set: { leaseUntil: new Date(0) } }).catch(() => {});
            busy = false;
        }
    };
    const cron = typeof interval === "object";
    const timer = cron ? new (require("cron").CronJob)(interval.cron, run, null, true, interval.timezone)
        : setInterval(run, interval);
    run();
    return async () => {
        stopped = true;
        if (cron) timer.stop(); else clearInterval(timer);
        while (busy) await new Promise(resolve => setTimeout(resolve, 50));
    };
}
module.exports = { schedule };
