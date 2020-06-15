const ParseProblem = require('../parsetypes/parse-problem');
const {SourceType, SourceAnnotation} = require('../source-type');
const {CEIType, Method} = require('java-mti');

/**
 * @param {SourceType} source_type 
 * @param {*} probs 
 */
function checkOverrides(source_type, probs) {
    if (source_type.extends_types.length === 0) {
        return;
    }
    if (source_type.typeKind !== 'class') {
        return;
    }

    /** @type {{ann:SourceAnnotation, method:Method, method_id:string}[]} */
    const overriden_methods = [];
    source_type.methods.reduce((arr, method) => {
        const ann = method.annotations.find(a => a.type.simpleTypeName === 'Override');
        if (ann) {
            arr.push({
                ann,
                method,
                method_id: `${method.name}${method.methodSignature}`,
            })
        }
        return arr;
    }, overriden_methods);

    if (!overriden_methods.length) {
        return;
    }

    const methods = new Set(), supers_done = new Set();
    const supers = source_type.supers.slice();
    while (supers.length) {
        const s = supers.shift();
        supers_done.add(s);
        s.methods.forEach(m => {
            methods.add(`${m.name}${m.methodSignature}`);
        });
        if (s instanceof CEIType) {
            s.supers.filter(s => !supers_done.has(s)).forEach(s => supers.push(s));
        }
    }

    overriden_methods.forEach(x => {
        if (!methods.has(x.method_id)) {
            probs.push(ParseProblem.Error(x.ann.annotationTypeIdent.tokens, `${x.method.label} does not override a matching method in any inherited type or interface`));
        }
    })
}

/**
 * @param {SourceType[]} source_types
 */
module.exports = function(source_types) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    source_types.forEach(type => checkOverrides(type, probs));
      
    return probs;
}
