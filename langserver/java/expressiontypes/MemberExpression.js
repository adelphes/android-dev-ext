/**
 * @typedef {import('../body-types').ResolvedIdent} ResolvedIdent
 * @typedef {import('../body-types').ResolveInfo} ResolveInfo
 * @typedef {import('../tokenizer').Token} Token
 */
const { Expression } = require("./Expression");
const { CEIType } = require('java-mti');
const { AnyType, MethodType } = require('../anys');
const { getTypeInheritanceList } = require('../expression-resolver');

class MemberExpression extends Expression {
    /**
     * @param {ResolvedIdent} instance
     * @param {Token|null} member
     */
    constructor(instance, member) {
        super();
        this.instance = instance;
        // member will be null for incomplete expressions
        this.member = member;
    }

    /**
     * @param {ResolveInfo} ri 
     */
    resolveExpression(ri) {
        const type = this.instance.resolveExpression(ri);
        if (!(type instanceof CEIType)) {
            return AnyType.Instance;
        }
        const ident = this.member.value;
        const field = type.fields.find(f => f.name === ident);
        if (field) {
            return field.type;
        }
        let methods = new Map();
        getTypeInheritanceList(type).forEach(type => {
            type.methods.forEach(m => {
                let msig;
                if (m.name === ident && !methods.has(msig = m.methodSignature)) {
                    methods.set(msig, m);
                }
            })
        });
        if (methods.size > 0) {
            return new MethodType([...methods.values()]);
        }
        return AnyType.Instance;
    }

    tokens() {
        return this.member;
    }
}

exports.MemberExpression = MemberExpression;
