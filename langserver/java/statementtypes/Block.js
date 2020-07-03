/**
 * @typedef {import('../tokenizer').Token} Token
 * @typedef {import('../body-types').Local} Local
 * @typedef {import('../body-types').Label} Label
 * @typedef {import('../body-types').ValidateInfo} ValidateInfo
 * @typedef {import('../source-types').SourceType} SourceType
 * @typedef {import('../source-types').SourceMethodLike} SourceMethodLike
 */
const { Statement } = require("./Statement");
const ParseProblem = require('../parsetypes/parse-problem');

class Block extends Statement {
    /** @type {Statement[]} */
    statements = [];

    /** @type {{locals: Local[], labels: Label[], types: SourceType[]}} */
    decls = null;

    /**
     * @param {SourceMethodLike} owner
     * @param {Token} open 
     */
    constructor(owner, open) {
        super(owner);
        this.open = open;
    }

    /**
     * @param {ValidateInfo} vi 
     */
    validate(vi) {
        if (this.decls) {
            const locals = this.decls.locals.reverse();
            locals.forEach(local => {
                if (locals.find(l => l.name === local.name) !== local) {
                    vi.problems.push(ParseProblem.Error(local.decltoken, `Variable redeclared: ${local.name}`))
                }
            });
        }
        for (let statement of this.statements) {
            statement.validate(vi);
        }
    }
}

exports.Block = Block;
