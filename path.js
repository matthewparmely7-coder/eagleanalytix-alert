const path = require("path");
const moduleAlias = require("module-alias");

moduleAlias.addAliases({
    patterns: path.join(__dirname, "patterns"),
    services: path.join(__dirname, "services"),
    models: path.join(__dirname, "models")
});
