const { TextBlock, TextBlockArray } = require('./parsetypes/textblock');
const { tokenize, Token } = require('./tokenizer');

/**
 *    Normalises comments, whitespace, string and character literals.
 * 
 *   - this makes the regexes used for parsing much simpler
 *   - we make a note of the MLCs as we need some of them for JavaDocs
 *   After preprocessing, the source layout should still be the same - spaces
 *   are used to fill the gaps where necessary
 * @param {string} source 
 */
function preprocess(source) {

    let mlcs = [];

    const re = /(\/\*[\d\D]*?\*\/)|(\/\/.*)|([^\S\n ]+)|(".*?")|('.')/g;
    let lastIndex = 0;
    let normalised_source = source.replace(re, (_, mlc, slc, other_ws, str, char) => {
        const idx = source.indexOf(_, lastIndex);
        lastIndex = idx + _.length;
        if (mlc) {
            mlcs.push({
                comment: _,
                index: idx,
            });
        } else if (str) {
            // string and character literals are filled with an invalid source character
            return `"${'#'.repeat(str.length - 2)}"`;
        } else if (char) {
            // string and character literals are filled with an invalid source character
            return `'#'`;
        }

        return _.replace(/./g,' ');
    });

    // also strip out parameters from annotations here - we don't need them to parse the source
    // and they make parsing messier.
    // at some point, we will add them back in to check them...
    normalised_source = stripAnnotationParameters(normalised_source);

    // the normalized source must have the same layout (line-lengths) as the original
    // - this is important to preserve token positioning
    if (normalised_source.length !== source.length) {
        throw new Error('Preprocessing altered source length');
    }

    return {
        original: source,
        normalised: normalised_source,
        mlcs,
    }
}

/**
 * Removes parameters from annotations, keeping the annotation identifiers
 * 
 * E.g @-Retention({"source"}) -> @-Retention
 * @param {string} source (normalised) source text
 */
function stripAnnotationParameters(source) {
    const parameterised_annotations_regex = /(@ *[a-zA-Z_]\w*(?: *\. *\w+)* *\()|(\()|(\))/g;
    let annotation_start = null;
    for (let m; m = parameterised_annotations_regex.exec(source); ) {
        if (!annotation_start) {
            if (m[1]) {
                annotation_start = {
                    balance: 1,
                    idx: m.index + m[0].length - 1,
                }
            }
            continue;
        }
        // we are inside an annotation and searching for the end
        if (m[1] || m[2]) {
            // another open bracket inside the annotation parameter
            annotation_start.balance++;
        } else if (m[3]) {
            // close bracket
            if (--annotation_start.balance === 0) {
                // we've reached the end of the annotation parameters
                const paramtext = source.slice(annotation_start.idx, m.index+1);
                source = `${source.slice(0, annotation_start.idx)}${paramtext.replace(/./g, ' ')}${source.slice(m.index+1)}`;
                annotation_start = null;
            }
        }
    }

    return source;
}

/**
 * @param {string} source (normalised) source text
 */
function scopify(source) {
    // \b(class|interface|enum|@ *interface)\b( +(\w+))?  - looks for a type declaration with optional name
    // (\. *)?  - this is used to ignore 'XYZ.class' expressions
    const module_scope = {
        kind: 'module',
        start: 0,
        open: null,
        end: source.length,
        name: null,
        inner_scopes: [],
        parent: null,
    };
    const scope_stack = [module_scope];
    let method_scope = null;
    const scopes_regex = /((\. *)?(\bclass|\binterface|\benum|@ *interface)\b(?: +(\w+))?)|(=[^;]*?\{)|(\{)|(\})/g;
    for (let m; m = scopes_regex.exec(source); ) {
        if (m[1]) {
            if (m[2]) {
                // ignore type keywords prefixed with .
                continue;
            }
            // start of a new type declaration
            const scope = {
                kind: m[3].startsWith('@') ? '@interface' : m[3],
                start: m.index,
                end: null,
                name: m[4] || null,
                inner_scopes: [],
                open: null,
                parent: scope_stack[0],
            }
            scope_stack[0].inner_scopes.push(scope);
            scope_stack.unshift(scope);
            continue;
        }
        if (m[5]) {
            // equals
            // searching for equals is a pain, but is necessary to prevent
            // field initialiser expressions like '{"arrinit"}' and 'new X() {}'  from
            // messing up scoping boundaries
            if (method_scope) {
                scopes_regex.lastIndex = m.index + 1;
                continue;   // ignore if we are inside a method
            }
            // parse the expression until we reach a semicolon, taking into account balanced scopes
            const expr_re = /(\{)|(\})|;/g;
            expr_re.lastIndex = m.index;
            let expr_balance = 0;
            for (let m; m = expr_re.exec(source);) {
                if (m[1]) expr_balance++;
                else if (m[2]) {
                    if (expr_balance === 0) {
                        // force a break if there are too many closes
                        scopes_regex.lastIndex = expr_re.lastIndex - 1;
                        break;
                    }
                    expr_balance--;
                } else if (expr_balance === 0) {
                    // semicolon reached
                    scopes_regex.lastIndex = expr_re.lastIndex;
                    break;
                }
            }
            continue;
        }
        if (m[6]) {
            // open brace
            if (method_scope) {
                method_scope.balance++;
                continue;
            }
            if (scope_stack[0].open === null) {
                // the start of the type body
                scope_stack[0].open = m.index;
                continue;
            }
            method_scope = {
                balance: 1,
            };
            continue;
        }
        // close brace
        if (method_scope) {
            if (--method_scope.balance === 0) {
                method_scope = null;
            }
            continue;
        }
        if (scope_stack.length > 1) {
            scope_stack[0].end = m.index+1;
            scope_stack.shift();
            continue;
        }
    }

    return module_scope;
}

function parse2(source) {
    console.time('preprocess');
    const preprocessed = preprocess(source);
    console.timeEnd('preprocess');

    // after preprocessing, divide the source into type scopes
    // - this allows us to quickly determine what named types are available
    // and to eliminate method implementations (which involve more complex parsing later).
    console.time('scopify');
    const scopes = scopify(preprocessed.normalised);
    console.timeEnd('scopify');
    scopes;

}

const markers = {
    arrayQualifier: 'A',
    blocks: 'B',
    constructor: 'C',
    dottedIdent: 'D',
    initialiser: 'E',
    field: 'F',
    parameter: 'F',
    method: 'G',
    typevarInterface: 'H',
    boundedTypeVar: 'I',
    extends: 'J',
    implements:'K',
    throws: 'L',
    modifier: 'M',
    package: 'N',
    import: 'O',
    primitive: 'P',
    annotation: 'Q',
    brackets: 'R',
    typeArgs: 'T',
    enumvalues: 'U',
    varDecl: 'V',
    ident: 'W',
    typeDecl: 'Z',
    error: ' ',
}

/**
 * 
 * @param {TextBlockArray} sourceblocks 
 * @param {string} id 
 * @param {RegExp} re 
 * @param {string} [marker] 
 * @param {boolean} [recursive] 
 * @param {{}} [parseClass]
 * @param {{time:boolean}} [opts]
 */
function group(sourceblocks, id, re, marker, recursive, parseClass, opts) {
    if (opts && opts.time) console.time(id);
    let grouped = [];
    let sourcemap = sourceblocks.sourcemap();
    if (!re.global) {
        throw new Error('regex must have the global flag enabled');
    }
    for (;;) {
        re.lastIndex = 0;
        const matches = [];
        for (let m; m = re.exec(sourcemap.simplified); ) {
            // every group must start and end on a definite boundary
            const start = sourcemap.map[m.index];
            let end = sourcemap.map[m.index + m[0].length - 1];
            if (end === undefined)
                end = sourcemap.map[m.index + m[0].length];
            if (start === undefined || end === undefined) {
                throw new Error('undefined group boundary')
            }
            // if no marker is defined, the first capturing group acts like a lookup
            const char = marker || markers[m[1]];
            if (!char) {
                throw new Error(`Missing marker for ${id}`);
            }
            const info = { start, end, match: m, replace: char, };
            // unshift so we end up in reverse order
            matches.unshift(info);
        }
        for (let {start, end, match, replace} of matches) {
            const shrunk = sourceblocks.shrink(id, start, end-start+1, match, replace, parseClass);
            // the blocks are shrunk in reverse order, so unshift to get the correct order
            grouped.unshift(shrunk);
        }
        if (recursive && matches.length) {
            sourcemap = sourceblocks.sourcemap();
            continue;
        }
        break;
    }
    if (opts && opts.time) console.timeEnd(id);
    return grouped;
}

class DeclarationBlock extends TextBlock {
    /**
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     */
    constructor(section, simplified) {
        super(section, simplified);
        //this.docs_token = section.blocks.filter(b => b.simplified.startsWith('\t')).pop();
        this.modifiers = section.blocks.filter(b => b.simplified.startsWith('M'));
        this.annotations = section.blocks.filter(b => b.simplified.startsWith('Q'));
    }

    get docs() {
        return '';// this.docs_token ? this.docs_token.source : '';
    }
}

class DeclaredVariableBlock extends DeclarationBlock {
    static parseRE = /([MQ](\s*[MQ])*\s+)?(V)( *=[^;MV]*)? *;/g

    /**
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     */
    constructor(section, simplified, match) {
        super(section, simplified);
        this.decl = section;
        const sm = section.sourcemap();
        /** @type {VarDeclBlock} */
        // @ts-ignore
        this.varBlock = section.blocks[sm.map[match[1] ? match[1].length : 0]];
    }

    get isVarArgs() {
        return !!this.varBlock.varargs_token;
    }

    /**
     * Return the field name
     */
    get name() {
        return this.varBlock ? this.varBlock.name : '';
    }

    get type() {
        return this.varBlock ? this.varBlock.type : '';
    }

    get typeTokens() {
        return this.varBlock ? this.varBlock.typeTokens : [];
    }
}

class FieldBlock extends DeclaredVariableBlock { }

class EnumValueBlock extends TextBlock {

    static parseRE = /(?<=^\{\s*)[W](\s*=[^,;]*)?(\s*,\s*[W](\s*=[^,;]*)?)*(\s*;)?/g

    /**
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     */
    constructor(section, simplified) {
        super(section, simplified);
    }

}

class ParameterBlock extends DeclaredVariableBlock {
    static parseRE = /([MQ](\s*[MQ])*\s+)?(V)/g
}


class MCBlock extends DeclarationBlock {

    /**
     * 
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     * @param {RegExpMatchArray} match 
     */
    constructor(section, simplified, match) {
        super(section, simplified);
        const sm = section.sourcemap();
        this.paramBlock = section.blocks[sm.map[match[0].indexOf('R')]];
        this.parsed = {
            parameters: null,
            /** @type {TextBlock[]} */
            errors: null,
        }
    }

    /**
     * @return {ParameterBlock[]}
     */
    get parameters() {
        if (!this.parsed.parameters) {
            const param_block = this.paramBlock.blockArray();
            parseArrayTypes(param_block);
            parseAnnotations(param_block);
            parseTypeArgs(param_block);
            const vars = group(param_block, 'var-decl', VarDeclBlock.parseRE, markers.varDecl, false, VarDeclBlock);
            this.parsed.parameters = group(param_block, 'param', ParameterBlock.parseRE, markers.parameter, false, ParameterBlock);
            // parameters must be a comma-separated list
            const sm = param_block.sourcemap();
            if (sm.simplified.search(/^\((\s*F(\s*,\s*F)*)?\s*\)/) === 0) {
                return this.parsed.parameters;
            }
            let invalid = sm.simplified.match(/^(\(\s*)(F?)(?:\s*,\s*F)*\s*/);
            if (!invalid) {
                // should never happen, but ignore
                return this.parsed.parameters;
            }
            const token_idx = invalid[2]
              ? sm.map[invalid[0].length] // there's a problem with a subsequent declaration
              : sm.map[invalid[1].length] // there's a problem with the first declaration
            const token = param_block.blocks[token_idx];
            if (!token) return this.parsed.parameters;
            this.parsed.errors = [token];
        }
        return this.parsed.parameters;
    }

    /**
     * Returns the TextBlock associated with the method body (or the semicolon)
     */
    body() {
        // always the last block atm
        const blocks = this.blockArray();
        return blocks.blocks[blocks.blocks.length - 1];
    }

    get name() {
        // overriden by subclasses
        return '';
    }

    /**
     * Return the method name and params, formatted on a single line
     */
    get nameAndParams() {
        return `${this.name}${this.paramBlock.source}`.replace(/\s+/g, ' ');
    }

    get parseErrors() {
        this.parameters;
        return this.parsed.errors;
    }
}

class MethodBlock extends MCBlock {
    static parseRE = /([MQT](?:\s*[MQT])*\s+)?(V\s*)R(\s*L)?\s*[B;]/g;

    /**
     * 
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     */
    constructor(section, simplified, match) {
        super(section, simplified, match);
        const sm = section.sourcemap();
        const varoffset = match[1] ? match[1].length : 0;
        /** @type {VarDeclBlock} */
        // @ts-ignore
        this.varBlock = section.blocks[sm.map[varoffset]];
    }

    /**
     * Return the method name
     */
    get name() {
        return this.varBlock ? this.varBlock.name : '';
    }

    get type() {
        return this.varBlock ? this.varBlock.type : '';
    }

    get typeTokens() {
        return this.varBlock ? this.varBlock.typeTokens : [];
    }
}

class ConstructorBlock extends MCBlock {
    static parseRE = /([MQT](?:\s*[MQT])*\s+)?(W\s*)R(\s*L)?\s*[B;]/g;

    /**
     * 
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     */
    constructor(section, simplified, match) {
        super(section, simplified, match);
        const sm = section.sourcemap();
        const name_offset = match[1] ? match[1].length : 0;
        /** @type {VarDeclBlock} */
        // @ts-ignore
        this.nameBlock = section.blocks[sm.map[name_offset]];
    }

    get name() {
        return this.nameBlock ? this.nameBlock.source : '';
    }
}

class InitialiserBlock extends DeclarationBlock {
    static parseRE = /([MQ](?:\s*[MQ])*\s+)?B/g;

    /**
     * 
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     */
    constructor(section, simplified, match) {
        super(section, simplified);
    }

    /**
     * Returns the TextBlock associated with the method body
     */
    body() {
        // always the last block atm
        const blocks = this.blockArray();
        return blocks.blocks[blocks.blocks.length - 1];
    }
}

class TypeDeclBlock extends DeclarationBlock {
    static parseRE = /([MQ](\s*[MQ])*\s+)?(class|enum|interface|@ *interface) +W(\s*T)?(\s*[JK])*\s*B/g;
    static marker = 'Z';

    /**
     * @param {TextBlockArray} blocks 
     * @param {string} simplified 
     */
    constructor(blocks, simplified) {
        super(blocks, simplified);
        this.decl = blocks;
        this.kindToken = this.decl.blocks.find(b => !/^[MQ\s]/.test(b.simplified));
        this.name_token = this.decl.blocks.find(b => b.simplified.startsWith('W'));
        this.typevars_token = this.decl.blocks.find(b => b.simplified.startsWith('T'));
        this.extends_decl = this.decl.blocks.find(b => b.simplified.startsWith('J'));
        this.implements_decl = this.decl.blocks.find(b => b.simplified.startsWith('K'));
        /** @type {TypeDeclBlock} */
        this.outer_type = null;
        /** @type {ModuleBlock} */
        this.mod = null;
        this.parsed = {
            /** @type {{name: string, decl:(TextBlock|BoundedTypeVar)}[]} */
            typevars: null,
            /** @type {FieldBlock[]} */
            fields: null,
            /** @type {MethodBlock[]} */
            methods: null,
            /** @type {ConstructorBlock[]} */
            constructors: null,
            /** @type {InitialiserBlock[]} */
            initialisers: null,
            /** @type {TypeDeclBlock[]} */
            types: null,
            /** @type {TextBlock[]} */
            errors: null,
        }
    }

    /**
     * Return the kind of type declared
     */
    kind() {
        /** @type {'class'|'enum'|'interface'|'@'} */
        // @ts-ignore
        const id = this.kindToken.toSource();
        return id === '@' ? '@interface' : id;
    }

    get fullyDottedName() {
        return this.shortSignature.replace(/[/$]/g, '.');
    }

    get shortSignature() {
        if (this.outer_type) {
            return `${this.outer_type.shortSignature}$${this.simpleName}`
        }
        const pkg = this.mod.packageName.replace(/\./g, '/');
        return `${pkg}${pkg ? '/' : ''}${this.simpleName}`
    }

    /**
     * Return the type name with no type-parameter info
     */
    get simpleName() {
        return this.name_token ? this.name_token.toSource() : '';
    }

    /**
     * Returns the TextBlock associated with the type body
     */
    body() {
        // always the last block atm
        return this.decl.blocks[this.decl.blocks.length - 1];
    }

    get typevars() {
        this._ensureParsed();
        return this.parsed.typevars;
    }

    get fields() {
        this._ensureParsed();
        return this.parsed.fields;
    }

    get methods() {
        this._ensureParsed();
        return this.parsed.methods;
    }

    get constructors() {
        this._ensureParsed();
        return this.parsed.constructors;
    }

    get initialisers() {
        this._ensureParsed();
        return this.parsed.initialisers;
    }

    get types() {
        this._ensureParsed();
        return this.parsed.types;
    }

    get parseErrors() {
        this._ensureParsed();
        return this.parsed.errors;
    }

    /**
     */
    _ensureParsed() {
        if (this.parsed.fields) {
            return;
        }
        this.parsed.typevars = [];
        if (this.typevars_token) {
            // split the token into a list of typevars
            // - each type var must be a simple ident (W), a bounded var (I)
            // or anonymous (?)
            this.parsed.typevars = this.typevars_token.blockArray()
                .blocks.reduce((arr,b) => {
                    if (/^[WI?]/.test(b.simplified)) {
                        arr.push({
                            decl: b,
                            get name_token() {
                                return this.decl instanceof BoundedTypeVar
                                    ? this.decl.range.blocks[0]
                                    : this.decl
                            },
                            get name() {
                                return this.name_token.source;
                            },
                        })
                    }
                    return arr;
                }, []);
        }
        const body = this.body().blockArray();
        parseArrayTypes(body);
        parseTypeArgs(body);
        parseAnnotations(body);
        parseEITDecls(body);
        /** @type {TypeDeclBlock[]} */
        this.parsed.types = parseTypeDecls(body, this, this.mod);

        group(body, 'var-decl', VarDeclBlock.parseRE, markers.varDecl, false, VarDeclBlock);
        if (this.kind() === 'enum') {
            /** @type {EnumValueBlock[]} */
            this.parsed.enums = group(body, 'enumvalue', EnumValueBlock.parseRE, markers.enumvalues, false, EnumValueBlock);
        }
        /** @type {FieldBlock[]} */
        this.parsed.fields = group(body, 'field', FieldBlock.parseRE, markers.field, false, FieldBlock);
        /** @type {MethodBlock[]} */
        this.parsed.methods = group(body, 'method', MethodBlock.parseRE, markers.method, false, MethodBlock);
        /** @type {ConstructorBlock[]} */
        this.parsed.constructors = group(body, 'constructor', ConstructorBlock.parseRE, markers.constructor, false, ConstructorBlock);
        /** @type {InitialiserBlock[]} */
        this.parsed.initialisers = group(body, 'initialiser', InitialiserBlock.parseRE, markers.initialiser, false, InitialiserBlock);
        // anything other than types, fields, methods, constructors, enums and initialisers are errors
        /** @type {TextBlock[]} */
        this.parsed.errors = group(body, 'type-body-error', /[^{}ZFGCEU\s;]+/g, markers.error);
    }
}

class PackageBlock extends DeclarationBlock {
    static parseRE = /([Q](\s*[Q])*\s*)?package +[DW] *;/g;

    /**
     * 
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     * @param {RegExpMatchArray} match 
     */
    constructor(section, simplified, match) {
        super(section, simplified);
        const sm = section.sourcemap();
        this.name_token = section.blocks[sm.map[(match[0].search(/[DW]/))]];
    }

    get name() {
        if (!this.name_token) return '';
        if (this.name_token.range instanceof TextBlockArray) {
            // dotted ident - strip any intermediate whitespace between the tokens
            const filtered = this.name_token.range.blocks.filter(b => !b.simplified.startsWith(' '));
            return filtered.map(b => b.source).join('');
        }
        // single ident
        return this.name_token.source;
    }
}

class ImportBlock extends DeclarationBlock {
    static parseRE = /([Q](\s*[Q])*\s*)?import( +M)? +[DW]( *\.\*)? *;/g

    /**
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     * @param {RegExpMatchArray} match 
     */
    constructor(section, simplified, match) {
        super(section, simplified);
        const sm = section.sourcemap();
        this._static_token = section.blocks[sm.map[(match[0].search(/M/))]];
        this._name_token = section.blocks[sm.map[(match[0].search(/[DW]/))]];
        this._demandload_token = section.blocks[sm.map[(match[0].search(/\*/))]];
    }

    get isStatic() {
        return this._static_token ? this._static_token.source === 'static' : false;
    }

    get isDemandLoad() {
        return !!this._demandload_token;
    }

    get name() {
        if (!this._name_token) return '';
        if (this._name_token.range instanceof TextBlockArray) {
            // dotted ident - strip any intermediate whitespace between the tokens
            const filtered = this._name_token.range.blocks.filter(b => !b.simplified.startsWith(' '));
            return filtered.map(b => b.source).join('');
        }
        // single ident
        return this._name_token.source;
    }
}

class ModuleBlock extends TextBlockArray {
    /**
     * @param {Token[]} blocks 
     */
    constructor(blocks) {
        super('module', blocks);
        this._parsed = null;

        // merge dotted identifiers
        group(this, 'dotted-ident', /W(?:\s*\.\s*W)+/g, markers.dottedIdent);
        group(this, 'brackets', /\([^()]*\)/g, markers.brackets, true);
        group(this, 'block', /\{[^{}]*\}/g, markers.blocks, true);
    }

    decls() {
        const parsed = this._ensureParsed();
        return [
            ...parsed.packages,
            ...parsed.imports,
            ...parsed.types,
        ].sort((a,b) => a.range.start - b.range.start);
    }

    get packageName() {
        const pkg_token = this.package;
        return pkg_token ? pkg_token.name : '';
    }

    get package() {
        return this._ensureParsed().packages[0];
    }

    get packages() {
        return this._ensureParsed().packages;
    }

    get imports() {
        return this._ensureParsed().imports;
    }

    get types() {
        return this._ensureParsed().types;
    }

    get parseErrors() {
        return this._ensureParsed().errors;
    }

    _ensureParsed() {
        if (this._parsed) {
            return this._parsed;
        }
        /** @type {PackageBlock[]} */
        const packages = parsePackages(this);
        const imports = parseImports(this);
        parseTypeArgs(this);
        parseAnnotations(this);
        parseEITDecls(this);
        const types = parseTypeDecls(this, null, this);
        // anything that's not a package, import or type declaration is an error
        const errors = group(this, 'module-errors', /[^NOZ;\s]+/g, ' ');
        return this._parsed = {
            packages,
            imports,
            types,
            errors,
        }
    }
}

/**
 * @param {TextBlockArray} sourceblocks 
 * @return {PackageBlock[]}
 */
function parsePackages(sourceblocks) {
    return group(sourceblocks, 'package', PackageBlock.parseRE, markers.package, false, PackageBlock);
}

/**
 * @param {TextBlockArray} sourceblocks 
 * @return {ImportBlock[]}
 */
function parseImports(sourceblocks) {
    return group(sourceblocks, 'import', ImportBlock.parseRE, markers.import, false, ImportBlock);
}

function parseArrayTypes(sourceblocks) {
    group(sourceblocks, 'array-type', /\[ *\](( *\[ *\])*)/g, markers.arrayQualifier);
}

function parseTypeArgs(sourceblocks) {
    // sort out type parameters + type arguments
    // re = /< *[PWD?]( *T)?( *A)?( *, *[PWD]( *T)?( *A)?)* *>/g;
    // const bounded_re = /[W?] +(extends|super) +[PWD?]( *T)?( *A)?( *& *[PWD?]( *T)?( *A)?)*/g;

    // we must perform a recursive type-args grouping before and after bounded typevars
    // to handle things like: 
    //  class X<T extends U<V<W>> & X<Y>>
    //     class W<W extends W<W<W>> & W<W>>
    // ->  class W<W extends WT & WT>
    // ->  class W<W extends WT H>
    // ->  class W<I>
    // ->  class WT
    const re = /< *[PWDI?]( *T)?( *A)?( *, *[PWDI?]( *T)?( *A)?)* *>/g;
    group(sourceblocks, 'type-args', re, markers.typeArgs, true);

    group(sourceblocks, 'typevar-bound-intf', TypeVarBoundInterface.parseRE, markers.typevarInterface, false, TypeVarBoundInterface);
    group(sourceblocks, 'bounded-typevar', BoundedTypeVar.parseRE, markers.boundedTypeVar, false, BoundedTypeVar);

    //const re = /< *[PWDI?]( *T)?( *A)?( *, *[PWDI]( *T)?( *A)?)* *>/g;
    //const re = /< *[PWD?]( +(extends|super) +[PWD?]( *T)?( *A)?( *& *[PWD?]( *T)?( *A)?)*)?( *T)?( *A)?( *, *[PWD]( +(extends|super) +[PWD?]( *T)?( *A)?( *& *[PWD?]( *T)?( *A)?)*)?( *T)?( *A)?)* *>/g;
    //const re = /(?<=[DW]\s*)<[ ]>/g;
    const ta2 = group(sourceblocks, 'type-args', re, markers.typeArgs, true);
}

function parseAnnotations(sourceblocks) {
    group(sourceblocks, 'annotation', /@ *[WD]( *R)?/g, markers.annotation);
}

function parseEITDecls(sourceblocks) {
    group(sourceblocks, 'eit-decl', /\b(extends|implements|throws)\s+[WD](\s*[WDT,.])*/g);
}

/**
 * @param {TextBlockArray} sourceblocks 
 * @param {TypeDeclBlock} outer_type
 * @param {ModuleBlock} mod
 */
function parseTypeDecls(sourceblocks, outer_type, mod) {
    /** @type {TypeDeclBlock[]} */
    const typedecls = group(sourceblocks, 'type-decl', TypeDeclBlock.parseRE, markers.typeDecl, false, TypeDeclBlock);
    typedecls.forEach(td => {
        td.outer_type = outer_type;
        td.mod = mod;
    });
    return typedecls;
}

/**
 * Optional interface bounds that follow a bounded type variable
 * e.g
 * 
 *  Type<T extends ArrayList & Comparable & Serializable>
 * 
 * marker: H
 */
class TypeVarBoundInterface extends TextBlock {
    static parseRE = /& *([PWD](?: *T)?(?: *\. *[PWD](?: *T)?)*)/g;

    /**
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     * @param {RegExpMatchArray} match
     */
    constructor(section, simplified, match) {
        super(section, simplified);
    }
}

/**
 * Bounded type variable
 * 
 * marker: I
 */
class BoundedTypeVar extends TextBlock {
    // we need the class|enum|interface lookbehind to prevent matches to class declarations with extends
    static parseRE = /(?<!\b(class|enum|interface) +)[W?] +(super|extends) +([PWD](?: *T)?(?: *\. *[PWD](?: *T)?)*)( *H)*/g;

    /**
     * 
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     * @param {RegExpMatchArray} match
     */
    constructor(section, simplified, match) {
        super(section, simplified);
    }
}

class VarDeclBlock extends TextBlock {
    // this definition is used for fields, parameters and locals
    // - it includes (...) for variable-arity parameters
    static parseRE = /([PWD](?: *T)?(?: *\. *[PWD](?: *T)?)*(?: *(A))?)( +| *(\.{3}) *)(W)(?: *(A))?/g;
    static marker = 'V';

    /**
     * 
     * @param {TextBlockArray} section 
     * @param {string} simplified 
     * @param {RegExpMatchArray} match
     */
    constructor(section, simplified, match) {
        super(section, simplified);
        const sm = section.sourcemap();
        const name_idx = sm.map[match[1].length + match[3].length];
        this.name_token = section.blocks[name_idx];
        const varargs_idx = sm.map[match[0].indexOf('...')];
        this.varargs_token = section.blocks[varargs_idx];
        let end_of_type_tokens = (varargs_idx || name_idx);
        // varargs may not have whitespace before it, but others do
        if (/^\s/.test(section.blocks[end_of_type_tokens - 1].simplified)) {
            end_of_type_tokens -= 1;
        }
        this.type_tokens = section.blocks.slice(0, end_of_type_tokens);
    }

    get name() {
        return this.name_token ? this.name_token.source : '';
    }

    get type() {
        return this.type_tokens.map(t => t.source).join('');
    }

    get typeTokens() {
        return this.type_tokens;
    }
}

/**
 * @param {string} source 
 */
function parse(source) {
    console.time('tokenize');
    const tokens = tokenize(source);
    console.timeEnd('tokenize');

    const mod = new ModuleBlock(tokens);
    return mod;
}

module.exports = {
    parse,
    TextBlock,
    TextBlockArray,
    ModuleBlock,
    PackageBlock,
    ImportBlock,
    TypeDeclBlock,
    FieldBlock,
    MethodBlock,
    ConstructorBlock,
    InitialiserBlock,
    DeclaredVariableBlock,
    ParameterBlock,
}
