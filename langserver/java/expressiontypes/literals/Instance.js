/**
 * @typedef {import('../../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../../tokenizer').Token} Token
 * @typedef {import('java-mti').CEIType} CEIType
 */
const { LiteralValue } = require('./LiteralValue');

class InstanceLiteral extends LiteralValue {
    /**
     * 
     * @param {Token} token 'this' or 'super' token
     * @param {CEIType} scoped_type 
     */
    constructor(token, scoped_type) {
        super(token, null);
        this.token = token;
        this.scoped_type = scoped_type;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        if (this.token.value === 'this') {
            return this.scoped_type;
        }
        return this.scoped_type.supers.find(t => t.typeKind === 'class') || ri.typemap.get('java/lang/Object');
    }
}

exports.InstanceLiteral = InstanceLiteral;
