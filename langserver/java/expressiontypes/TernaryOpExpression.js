/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 */
const { Expression } = require("./Expression");

class TernaryOpExpression extends Expression {
    /**
     * @param {ResolvedIdent} test
     * @param {ResolvedIdent} truthExpression
     * @param {ResolvedIdent} falseExpression
     */
    constructor(test, truthExpression, falseExpression) {
        super();
        this.test = test;
        this.truthExpression = truthExpression;
        this.falseExpression = falseExpression;
    }
}

exports.TernaryOpExpression = TernaryOpExpression;
