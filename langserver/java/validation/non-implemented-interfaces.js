const ParseProblem = require('../parsetypes/parse-problem');
const { SourceType } = require('../source-types');
const { CEIType, Method} = require('java-mti');
const {isTypeAssignable} = require('../expression-resolver');

function nonAbstractLabel(label) {
    return label.replace(/\babstract /g, '');
}

/**
 * 
 * @param {Method} impl method implementation
 * @param {Method} method interface method
 */
function isMethodCompatible(impl, method) {
    const impl_params = impl.parameters;
    const method_params = method.parameters;
    if (impl_params.length !== method_params.length) {
        return false;
    }
    return impl_params.every((p,idx) => isTypeAssignable(method_params[idx].type, p.type))
        && isTypeAssignable(method.returnType, impl.returnType);
}

/**
 * @param {SourceType} source_type 
 * @param {*} probs 
 */
function checkImplementedInterfaces(source_type, probs) {
    if (source_type.implements_types.length === 0) {
        return;
    }
    if (source_type.typeKind === 'interface') {
        return;
    }
    if (source_type.modifiers.includes('abstract')) {
        return;
    }
    /** @type {Set<CEIType>} */
    const interfaces = new Set(), supers_done = new Set();
    const supers = source_type.supers.slice();
    while (supers.length) {
        const s = supers.shift();
        supers_done.add(s);
        if (s instanceof CEIType) {
            if (s.typeKind === 'interface') {
                interfaces.add(s);
            }
            s.supers.filter(s => !supers_done.has(s)).forEach(s => supers.push(s));
        }
    }

    const implemented = source_type.methods.map(m => `${m.name}${m.methodSignature}`);
    interfaces.forEach((intf, i) => {
        const missing_methods = [];
        intf.methods.forEach(m => {
            // default methods don't require implementing
            if (m.hasImplementation) {
                return;
            }
            const namedsig = `${m.name}${m.methodSignature}`
            if (implemented.indexOf(namedsig) < 0) {
                // perform a more detailed search for a compatible match
                if (!source_type.methods.find(source_method => source_method.name === m.name && isMethodCompatible(source_method, m))) {
                    missing_methods.push(nonAbstractLabel(m.label));
                }
            }
        })
        if (missing_methods.length) {
            probs.push(ParseProblem.Error(source_type.kind_token, `Non-abstract ${source_type.typeKind} '${source_type.fullyDottedRawName}' does not implement the following methods from interface '${intf.fullyDottedTypeName}':\n${missing_methods.join('\n')}`));
        }
    });
}

/**
 * @param {SourceType[]} source_types
 */
module.exports = function(source_types) {
    /** @type {ParseProblem[]} */
    const probs = [];
      
    source_types.forEach(type => checkImplementedInterfaces(type, probs));
      
    return probs;
}
