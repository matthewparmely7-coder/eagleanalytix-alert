function envNum(name, fallback) {
    const n = parseFloat(process.env[name]);
    return Number.isFinite(n) ? n : fallback;
}

function jumpMeets(percent, amount, minPercent, minAmount) {
    const pctOk = minPercent <= 0 || percent >= minPercent;
    const amtOk = minAmount <= 0 || amount >= minAmount;
    return pctOk && amtOk;
}

function thresholds() {
    return {
        supplyJumpPercent: envNum("SUPPLY_JUMP_PERCENT", 30),
        supplyJumpCount: envNum("SUPPLY_JUMP_COUNT", 0),
        supplyHistoryDays: Math.max(envNum("SUPPLY_HISTORY_DAYS", 3), 1),
        supplyActionHours: Math.max(envNum("SUPPLY_ACTION_HOURS", 6), 1),
        rocketJumpPercent: envNum("ROCKET_JUMP_PERCENT", 25),
        rocketJumpPrice: envNum("ROCKET_JUMP_PRICE", 0),
        rocketHistoryDays: Math.max(envNum("ROCKET_HISTORY_DAYS", 10), 1),
        rocketActionDays: Math.max(envNum("ROCKET_ACTION_DAYS", 3), 1),
        rocketQuietPercent: envNum("ROCKET_QUIET_PERCENT", 10),
        uShapeTroughDays: Math.max(envNum("U_SHAPE_TROUGH_DAYS", 5), 1),
        uShapeDropDays: Math.max(envNum("U_SHAPE_DROP_DAYS", 2), 1),
        uShapeVariationPercent: envNum("U_SHAPE_VARIATION_PERCENT", 10),
        uShapeDipPercent: envNum("U_SHAPE_DIP_PERCENT", 25),
        uShapeJumpPercent: envNum("U_SHAPE_JUMP_PERCENT", 25),
        uShapeJumpPrice: envNum("U_SHAPE_JUMP_PRICE", 0),
        uShapeActionDays: Math.max(envNum("U_SHAPE_ACTION_DAYS", 3), 1)
    };
}

module.exports = { envNum, jumpMeets, thresholds };
