// Eight Event Alert patterns. Detectors are stubs for now.

const PATTERN_IDS = [
    "supply_change_40",
    "u_shaped",
    "rocket",
    "last_show",
    "low_resale_primary_sells_out",
    "tier_pricing",
    "later_tour",
    "low_resale_high_demand"
];

module.exports = {
    PATTERN_IDS,
    supplyChange: require("./supplyChange")
};
