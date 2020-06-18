/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
*/
const { Expression } = require("./Expression");
const { MultiValueType } = require('../anys');

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

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const ttype = this.truthExpression.resolveExpression(ri);
        const ftype = this.falseExpression.resolveExpression(ri);
        return new MultiValueType(ttype, ftype);
    }

    tokens() {
        return [...this.test.tokens, ...this.truthExpression.tokens, ...this.falseExpression.tokens];
    }
}

exports.TernaryOpExpression = TernaryOpExpression;
