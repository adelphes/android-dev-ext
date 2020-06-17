const { Statement } = require("./Statement");

class AssertStatement extends Statement {
    expression = null;
    message = null;
}

exports.AssertStatement = AssertStatement;
