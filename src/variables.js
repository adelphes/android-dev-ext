'use strict'

const { JTYPES, exmsg_var_name, createJavaString } = require('./globals');
const NumberBaseConverter = require('./nbc');
const $ = require('./jq-promise');

/*
    Class used to manage stack frame locals and other evaluated expressions
*/
class AndroidVariables {

    constructor(session, baseId) {
        this.session = session;
        this.dbgr = session.dbgr;
        // the incremental reference id generator for stack frames, locals, etc
        this.nextId = baseId;
        // hashmap of variables and frames
        this.variableHandles = {};
        // hashmap<objectid, variablesReference>
        this.objIdCache = {};
        // allow primitives to be expanded to show more info
        this._expandable_prims = false;
    }
    
    addVariable(varinfo) {
        var variablesReference = ++this.nextId;
        this.variableHandles[variablesReference] = varinfo;
        return variablesReference;
    }

    clear() {
        this.variableHandles = {};
    }

    setVariable(variablesReference, varinfo) {
        this.variableHandles[variablesReference] = varinfo;
    }

    _getObjectIdReference(type, objvalue) {
        // we need the type signature because we must have different id's for
        // an instance and it's supertype instance (which obviously have the same objvalue)
        var key = type.signature + objvalue;
        return this.objIdCache[key] || (this.objIdCache[key] = ++this.nextId);
    }

    getVariables(variablesReference) {
        var varinfo = this.variableHandles[variablesReference];
        if (!varinfo) {
            return $.Deferred().resolve([]);
        }
        else if (varinfo.cached) {
            return $.Deferred().resolve(this._local_to_variable(varinfo.cached));
        }
        else if (varinfo.objvar) {
            // object fields request
            return this.dbgr.getsupertype(varinfo.objvar, {varinfo})
                .then((supertype, x) => {
                    x.supertype = supertype;
                    return this.dbgr.getfieldvalues(x.varinfo.objvar, x);
                })
                .then((fields, x) => {
                    // add an extra msg field for exceptions
                    if (!x.varinfo.exception) return;
                    x.fields = fields;
                    return this.dbgr.invokeToString(x.varinfo.objvar.value, x.varinfo.threadid, varinfo.objvar.type.signature, x)
                        .then((call,x) => {
                            call.name = exmsg_var_name;
                            x.fields.unshift(call);
                            return $.Deferred().resolveWith(this, [x.fields, x]);
                        });
                })
                .then((fields, x) => {
                    // ignore supertypes of Object
                    x.supertype && x.supertype.signature!=='Ljava/lang/Object;' && fields.unshift({
                        vtype:'super',
                        name:':super',
                        hasnullvalue:false,
                        type: x.supertype,
                        value: x.varinfo.objvar.value,
                        valid:true,
                    });
                    // create the fully qualified names to use for evaluation
                    fields.forEach(f => f.fqname = `${x.varinfo.objvar.fqname || x.varinfo.objvar.name}.${f.name}`);
                    x.varinfo.cached = fields;
                    return this._local_to_variable(fields);
                });
        }
        else if (varinfo.arrvar) {
            // array elements request
            var range = varinfo.range, count = range[1] - range[0];
            // should always have a +ve count, but just in case...
            if (count <= 0) return $.Deferred().resolve([]);
            // add some hysteresis
            if (count > 110) {
                // create subranges in the sub-power of 10
                var subrangelen = Math.max(Math.pow(10, (Math.log10(count)|0)-1),100), variables = [];
                for (var i=range[0],varref,v; i < range[1]; i+= subrangelen) {
                    varref = ++this.nextId;
                    v = this.variableHandles[varref] = { varref:varref, arrvar:varinfo.arrvar, range:[i, Math.min(i+subrangelen, range[1])] };
                    variables.push({name:`[${v.range[0]}..${v.range[1]-1}]`,type:'',value:'',variablesReference:varref});
                }
                return $.Deferred().resolve(variables);
            }
            // get the elements for the specified range
            return this.dbgr.getarrayvalues(varinfo.arrvar, range[0], count, {varinfo})
                .then((elements, x) => {
                    elements.forEach(el => el.fqname = `${x.varinfo.arrvar.fqname || x.varinfo.arrvar.name}[${el.name}]`);
                    x.varinfo.cached = elements;
                    return this._local_to_variable(elements);
                });
        }
        else if (varinfo.bigstring) {
            return this.dbgr.getstringchars(varinfo.bigstring.value)
                .then((s) => {
                    return this._local_to_variable([{name:'<value>',hasnullvalue:false,string:s,type:JTYPES.String,valid:true}]);
                });
        }
        else if (varinfo.primitive) {
            // convert the primitive value into alternate formats
            var variables = [], bits = {J:64,I:32,S:16,B:8}[varinfo.signature];
            const pad = (u,base,len) => ('0000000000000000000000000000000'+u.toString(base)).slice(-len);
            switch(varinfo.signature) {
                case 'Ljava/lang/String;':
                    variables.push({name:'<length>',type:'',value:varinfo.value.toString(),variablesReference:0});
                    break;
                case 'C': 
                    variables.push({name:'<charCode>',type:'',value:varinfo.value.charCodeAt(0).toString(),variablesReference:0});
                    break;
                case 'J':
                    // because JS cannot handle 64bit ints, we need a bit of extra work
                    var v64hex = varinfo.value.replace(/[^0-9a-fA-F]/g,'');
                    const s4 = { hi:parseInt(v64hex.slice(0,8),16), lo:parseInt(v64hex.slice(-8),16) };
                    variables.push(
                        {name:'<binary>',type:'',value:pad(s4.hi,2,32)+pad(s4.lo,2,32),variablesReference:0}
                        ,{name:'<decimal>',type:'',value:NumberBaseConverter.hexToDec(v64hex,false),variablesReference:0}
                        ,{name:'<hex>',type:'',value:pad(s4.hi,16,8)+pad(s4.lo,16,8),variablesReference:0}
                    );
                    break;
                default:// integer/short/byte value
                    const u = varinfo.value >>> 0;
                    variables.push(
                        {name:'<binary>',type:'',value:pad(u,2,bits),variablesReference:0}
                        ,{name:'<decimal>',type:'',value:u.toString(10),variablesReference:0}
                        ,{name:'<hex>',type:'',value:pad(u,16,bits/4),variablesReference:0}
                    );
                    break;
            }
            return $.Deferred().resolve(variables);
        }
        else if (varinfo.frame) {
            // frame locals request - this should be handled by AndroidDebugThread instance
            return $.Deferred().resolve([]);
        } else {
            // something else?
            return $.Deferred().resolve([]);
        }
    }

     /**
     * Converts locals (or other vars) in debugger format into Variable objects used by VSCode
     */
    _local_to_variable(v) {
        if (Array.isArray(v)) return v.filter(v => v.valid).map(v => this._local_to_variable(v));
        var varref = 0, objvalue, evaluateName = v.fqname || v.name, formats = {}, typename = v.type.package ? `${v.type.package}.${v.type.typename}` : v.type.typename;
        switch(true) {
            case v.hasnullvalue && JTYPES.isReference(v.type):
                // null object or array type
                objvalue = 'null';
                break;
            case v.type.signature === JTYPES.Object.signature:
                // Object doesn't really have anything worth seeing, so just treat it as unexpandable
                objvalue = v.type.typename;
                break;
            case v.type.signature === JTYPES.String.signature:
                objvalue = JSON.stringify(v.string);
                if (v.biglen) {
                    // since this is a big string - make it viewable on expand
                    varref = ++this.nextId;
                    this.variableHandles[varref] = {varref:varref, bigstring:v};
                    objvalue = `String (length:${v.biglen})`;
                }
                else if (this._expandable_prims) {
                    // as a courtesy, allow strings to be expanded to see their length
                    varref = ++this.nextId;
                    this.variableHandles[varref] = {varref:varref, signature:v.type.signature, primitive:true, value:v.string.length};
                }
                break;
            case JTYPES.isArray(v.type):
                // non-null array type - if it's not zero-length add another variable reference so the user can expand
                if (v.arraylen) {
                    varref = this._getObjectIdReference(v.type, v.value);
                    this.variableHandles[varref] = { varref:varref, arrvar:v, range:[0,v.arraylen] };
                }
                objvalue = v.type.typename.replace(/]/, v.arraylen+']');   // insert len as the first array bound
                break;
            case JTYPES.isObject(v.type):
                // non-null object instance - add another variable reference so the user can expand
                varref = this._getObjectIdReference(v.type, v.value);
                this.variableHandles[varref] = {varref:varref, objvar:v};
                objvalue = v.type.typename;
                break;
            case v.type.signature === 'C': 
                const cmap = {'\b':'b','\f':'f','\r':'r','\n':'n','\t':'t','\v':'v','\'':'\'','\\':'\\'};
                if (cmap[v.char]) {
                    objvalue = `'\\${cmap[v.char]}'`;
                } else if (v.value < 32) {
                    objvalue = v.value ? `'\\u${('000'+v.value.toString(16)).slice(-4)}'` : "'\\0'";
                } else objvalue = `'${v.char}'`;
                break;
            case v.type.signature === 'J':
                // because JS cannot handle 64bit ints, we need a bit of extra work
                var v64hex = v.value.replace(/[^0-9a-fA-F]/g,'');
                objvalue = formats.dec = NumberBaseConverter.hexToDec(v64hex, true);
                formats.hex = '0x' + v64hex.replace(/^0+/, '0');
                formats.oct = formats.bin = '';
                // 24 bit chunks...
                for (var s=v64hex,uint; s; s = s.slice(0,-6)) {
                    uint = parseInt(s.slice(-6), 16) >>> 0; // 6*4 = 24 bits
                    formats.oct = uint.toString(8) + formats.oct;
                    formats.bin = uint.toString(2) + formats.bin;
                }
                formats.oct = '0c' + formats.oct.replace(/^0+/, '0');
                formats.bin = '0b' + formats.bin.replace(/^0+/, '0');
                break;
            case /^[BIS]$/.test(v.type.signature):
                objvalue = formats.dec = v.value.toString();
                var uint = (v.value >>> 0);
                formats.hex = '0x' + uint.toString(16);
                formats.oct = '0c' + uint.toString(8);
                formats.bin = '0b' + uint.toString(2);
                break;
            default:
                // other primitives: boolean, etc
                objvalue = v.value.toString();
                break;
        }
        // as a courtesy, allow integer and character values to be expanded to show the value in alternate bases
        if (this._expandable_prims && /^[IJBSC]$/.test(v.type.signature)) {
            varref = ++this.nextId;
            this.variableHandles[varref] = {varref:varref, signature:v.type.signature, primitive:true, value:v.value};
        }
        return {
            name: v.name,
            type: typename,
            value: objvalue,
            evaluateName,
            variablesReference: varref,
        }
    }

    setVariableValue(args) {
        const failSetVariableRequest = reason => $.Deferred().reject(new Error(reason));

        var v = this.variableHandles[args.variablesReference];
        if (!v || !v.cached) {
            return failSetVariableRequest(`Variable '${args.name}' not found`);
        }

        var destvar = v.cached.find(v => v.name===args.name);
        if (!destvar || !/^(field|local|arrelem)$/.test(destvar.vtype)) {
            return failSetVariableRequest(`The value is read-only and cannot be updated.`);
        }

        // be nice and remove any superfluous whitespace
        var value = args.value.trim();

        if (!value) {
            // just ignore blank requests
            var vsvar = this._local_to_variable(destvar);
            return $.Deferred().resolve(vsvar);
        }

        // non-string reference types can only set to null
        if (/^L/.test(destvar.type.signature) && destvar.type.signature !== JTYPES.String.signature) {
            if (value !== 'null') {
                return failSetVariableRequest('Object references can only be set to null');
            }
        }

        // convert the new value into a debugger-compatible object
        var m, num, data, datadef;
        switch(true) {
            case value === 'null':
                data = {valuetype:'oref',value:null}; // null object reference
                break;
            case /^(true|false)$/.test(value):
                data = {valuetype:'boolean',value:value!=='false'}; // boolean literal
                break;
            case !!(m=value.match(/^[+-]?0x([0-9a-f]+)$/i)):
                // hex integer- convert to decimal and fall through
                if (m[1].length < 52/4)
                    value = parseInt(value, 16).toString(10);
                else
                    value = NumberBaseConverter.hexToDec(value);
                m=value.match(/^[+-]?[0-9]+([eE][+]?[0-9]+)?$/);
                // fall-through
            case !!(m=value.match(/^[+-]?[0-9]+([eE][+]?[0-9]+)?$/)):
                // decimal integer
                num = parseFloat(value, 10);    // parseInt() can't handle exponents
                switch(true) {
                    case (num >= -128 && num <= 127): data = {valuetype:'byte',value:num}; break;
                    case (num >= -32768 && num <= 32767): data = {valuetype:'short',value:num}; break;
                    case (num >= -2147483648 && num <= 2147483647): data = {valuetype:'int',value:num}; break;
                    case /inf/i.test(num): return failSetVariableRequest(`Value '${value}' exceeds the maximum number range.`);
                    case /^[FD]$/.test(destvar.type.signature): data = {valuetype:'float',value:num}; break;
                    default:
                        // long (or larger) - need to use the arbitrary precision class
                        data = {valuetype:'long',value:NumberBaseConverter.decToHex(value, 16)};
                        switch(true){
                            case data.value.length > 16: 
                            case num > 0 && data.value.length===16 && /[^0-7]/.test(data.value[0]):
                                // number exceeds signed 63 bit - make it a float
                                data = {valuetype:'float',value:num}; 
                                break;
                        }
                }
                break;            
            case !!(m=value.match(/^(Float|Double)\s*\.\s*(POSITIVE_INFINITY|NEGATIVE_INFINITY|NaN)$/)):
                // Java special float constants
                data = {valuetype:m[1].toLowerCase(),value:{POSITIVE_INFINITY:Infinity,NEGATIVE_INFINITY:-Infinity,NaN:NaN}[m[2]]};
                break;
            case !!(m=value.match(/^([+-])?infinity$/i)):// allow js infinity
                data = {valuetype:'float',value:m[1]!=='-'?Infinity:-Infinity};
                break;
            case !!(m=value.match(/^nan$/i)): // allow js nan
                data = {valuetype:'float',value:NaN};
                break;
            case !!(m=value.match(/^[+-]?[0-9]+[eE][-][0-9]+([dDfF])?$/)):
            case !!(m=value.match(/^[+-]?[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?([dDfF])?$/)):
                // decimal float
                num = parseFloat(value);
                data = {valuetype:/^[dD]$/.test(m[1]) ? 'double': 'float',value:num}; 
                break;
            case !!(m=value.match(/^'(?:\\u([0-9a-fA-F]{4})|\\([bfrntv0'])|(.))'$/)):
                // character literal
                var cvalue = m[1] ? String.fromCharCode(parseInt(m[1],16)) : 
                    m[2] ? {b:'\b',f:'\f',r:'\r',n:'\n',t:'\t',v:'\v',0:'\0',"'":"'"}[m[2]]
                    : m[3]
                data = {valuetype:'char',value:cvalue};
                break;
            case !!(m=value.match(/^"[^"\\\n]*(\\.[^"\\\n]*)*"$/)):
                // string literal - we need to get the runtime to create a new string first
                datadef = createJavaString(this.dbgr, value).then(stringlit => ({valuetype:'oref', value:stringlit.value}));
                break;
            default:
                // invalid literal
                return failSetVariableRequest(`'${value}' is not a valid Java literal.`);
        }

        if (!datadef) {
            // as a nicety, if the destination is a string, stringify any primitive value
            if (data.valuetype !== 'oref' && destvar.type.signature === JTYPES.String.signature) {
                datadef = createJavaString(this.dbgr, data.value.toString(), {israw:true})
                    .then(stringlit => ({valuetype:'oref', value:stringlit.value}));
            } else if (destvar.type.signature.length===1) {
                // if the destination is a primitive, we need to range-check it here
                // Neither our debugger nor the JDWP endpoint validates primitives, so we end up with
                // weirdness if we allow primitives to be set with out-of-range values
                var validmap = {
                    B:'byte,char',   // char may not fit - we special-case this later
                    S:'byte,short,char',
                    I:'byte,short,int,char',
                    J:'byte,short,int,long,char',
                    F:'byte,short,int,long,char,float',
                    D:'byte,short,int,long,char,double,float',
                    C:'byte,short,char',Z:'boolean',
                    isCharInRangeForByte: c => c.charCodeAt(0) < 256,
                };
                var is_in_range = (validmap[destvar.type.signature]||'').indexOf(data.valuetype) >= 0;
                if (destvar.type.signature === 'B' && data.valuetype === 'char')
                    is_in_range = validmap.isCharInRangeForByte(data.value);
                if (!is_in_range) {
                    return failSetVariableRequest(`'${value}' is not compatible with variable type: ${destvar.type.typename}`);
                }
                // check complete - make sure the type matches the destination and use a resolved deferred with the value
                if (destvar.type.signature!=='C' && data.valuetype === 'char') 
                    data.value = data.value.charCodeAt(0);  // convert char to it's int value
                if (destvar.type.signature==='J' && typeof data.value === 'number') 
                    data.value = NumberBaseConverter.decToHex(''+data.value,16);  // convert ints to hex-string longs
                data.valuetype = destvar.type.typename;

                datadef = $.Deferred().resolveWith(this,[data]);
            }
        }

        return datadef.then(data => {
            // setxxxvalue sets the new value and then returns a new local for the variable
            switch(destvar.vtype) {
                case 'field': return this.dbgr.setfieldvalue(destvar, data);
                case 'local': return this.dbgr.setlocalvalue(destvar, data);
                case 'arrelem': 
                    var idx = parseInt(args.name, 10), count=1;
                    if (idx < 0 || idx >= destvar.data.arrobj.arraylen) throw new Error('Array index out of bounds');
                    return this.dbgr.setarrayvalues(destvar.data.arrobj, idx, count, data);
                default: throw new Error('Unsupported variable type');
            }
        })
        .then(newlocalvar => {
            if (destvar.vtype === 'arrelem') newlocalvar = newlocalvar[0];
            Object.assign(destvar, newlocalvar);
            var vsvar = this._local_to_variable(destvar);
            return vsvar;
        })
        .fail(e => {
            return failSetVariableRequest(`Variable update failed. ${e.message||''}`);
        });
    }
}

exports.AndroidVariables = AndroidVariables;
