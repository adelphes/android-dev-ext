const START_NAMESPACE_SPEC = {
    hdr: '0x0100',
    hdrsz: '0x0010',
    sz: '0x00000018',
    startline: 4,
    commentId: 4,
    nameId: 4,
    valueId: 4,
}
const END_NAMESPACE_SPEC = {
    hdr: '0x0101',
    hdrsz: '0x0010',
    sz: '0x00000018',
    startline: 4,
    commentId: 4,
    nameId: 4,
    valueId: 4,
}
const BEGIN_NODE_SPEC = {
    hdr: '0x0102',
    hdrsz: '0x0010',
    sz: 4,
    startline: 4,
    commentId: 4,
    namespaceId: 4,
    nameId: 4,
    attr: {
        offset: 2,
        size: 2,
        count: 2,
    },
    id_attr_offset: 2,
    cls_attr_offset: 2,
    style_attr_offset: 2,
    attributes: [{
        length: main => main.attr.count,
        element_spec: {
            ns: 4,
            nameId: 4,
            commentId: 4,
            sz: '0x0008',
            zero: '0x00',
            type: 1,
            value: 4,
        }
    }]
}

const END_NODE_SPEC = {
    hdr: '0x0103',
    hdrsz: '0x0010',
    sz: 4,
    startline: 4,
    commentId: 4,
    namespaceId: 4,
    nameId: 4,
}

function decode_spec_value(o, key, value, buf, idx, main) {
    let byteLength;
    switch (true) {
        case typeof value === 'number': {
            // raw integer value
            byteLength = value;
            o[key] = buf.readIntLE(idx, byteLength);
            break;
        }
        case Array.isArray(value): {
            // known-length array of values
            const length = value[0].length(main);
            byteLength = 0;
            o[key] = new Array(length);
            for (let i = 0; i < length; i++) {
                const bytes = decode_spec_value(o[key], i, value[0].element_spec, buf, idx, main);
                idx += bytes;
                byteLength += bytes;
            }
            break;
        }
        case typeof value === 'object': {
            // named sub-spec
            o[key] = {};
            byteLength = decode_spec(buf, value, o[key], o, idx);
            break
        }
        case /^0x[\da-fA-F]/.test(value): {
            // exact integer value
            byteLength = (value.length - 2) / 2;
            o[key] = buf.readUIntLE(idx, byteLength);
            if (parseInt(value) !== o[key]) {
                throw new Error(`Bad value. Expected ${value}, got 0x${o[key].toString(16)}`);
            }
            break;
        }
        case value === 'length-utf16-null': {
            // 2-byte length, utf16 chars, null char
            const string_byte_length = buf.readUInt16LE(idx) * 2;   // 1 char = 2 bytes
            idx += 2;
            o[key] = buf.slice(idx, idx + string_byte_length).toString('ucs2');
            idx += string_byte_length;
            if (buf.readUInt16LE(idx) !== 0) {
                throw new Error(`Bad value. Nul char expected but not found.`);
            }
            byteLength = 2 + string_byte_length + 2;
            break;
        }
        case /^align:\d+$/.test(value): {
            // used for arbitrary padding to a specified alignment
            const align = parseInt(value.split(':')[1], 10);
            byteLength = align - (idx % align);
            o[key] = buf.slice(idx, idx + byteLength);
            break;
        }
        default: throw new Error(`Unknown spec value definition: ${value}`);
    }
    return byteLength;
}

function decode_spec(buf, spec, o = {}, main = o, idx = 0) {

    let byteLength = 0;
    for (let key of Object.keys(spec)) {
        const value = spec[key];
        const bytes = decode_spec_value(o, key, value, buf, idx, main);
        idx += bytes;
        byteLength += bytes;
    }

    return byteLength;
}

/**
 * Converts a binary XML file back into a readable XML document
 * @param {Buffer} buf binary XMl content
 */
function decode_binary_xml(buf) {
    const xml_spec = {
        header: '0x00080003',
        headerSize: 4,
        stringPool: {
            header: '0x0001',
            hdrsize: '0x001c',
            sz: 4,
            stringCount: 4,
            styleCount: 4,
            flags: 4,
            stringStart: 4,
            styleStart: 4,
            stringOffsets: [{
                length: main => main.stringPool.stringCount,
                element_spec: 4,
            }],
            strings: [{
                length: main => main.stringPool.stringCount,
                element_spec: 'length-utf16-null',
            }],
            padding: 'align:4',
        },
        resourceIDPool: {
            hdr: '0x0180',
            hdrsize: '0x0008',
            sz: 4,
            resIDs: [{
                length: main => (main.resourceIDPool.sz - main.resourceIDPool.hdrsize) / 4,
                element_spec: 4,
            }]
        }
    }

    const decoded = {};
    let idx = decode_spec(buf, xml_spec, decoded);

    // after we've extracted the string and id's, it should be time to parse the xml
    const node_stack = [{ nodes: [] }];
    const namespaces = [];
    while (idx < buf.byteLength) {
        const id = buf.readUInt16LE(idx);
        switch (id) {
            case 0x0100: {
                // start namespace
                const node = {};
                idx += decode_spec(buf, START_NAMESPACE_SPEC, node, node, idx);
                namespaces.push(node);
                break;
            }
            case 0x0101: {
                // end namespace
                const node = {};
                idx += decode_spec(buf, END_NAMESPACE_SPEC, node, node, idx);
                const i = namespaces.findIndex(ns => ns.nameId === node.nameId);
                namespaces.splice(i, 1);
                break;
            }
            case 0x0102: {
                // begin node
                const node = {
                    nodes: [],
                };
                idx += decode_spec(buf, BEGIN_NODE_SPEC, node, node, idx);
                node.namespaces = namespaces.slice();
                node.namespaces.forEach(ns => {
                    if (!ns.node) ns.node = node;
                });
                node_stack[0].nodes.push(node);
                node_stack.unshift(node);
                break;
            }
            case 0x0103: {
                // end node
                const spec = END_NODE_SPEC;
                const node = {};
                idx += decode_spec(buf, spec, node, node, idx);
                node_stack.shift();
                break;
            }
            default: throw new Error(`Unknown XML element ${id.toString(16)}`);
        }
    }
    decoded.nodes = node_stack[0].nodes;

    const xml = toXMLDocument(decoded);
    return xml;
}

/**
 * Convert the decoded binary XML to a readable XML document
 * @param {*} decoded 
 */
function toXMLDocument(decoded) {
    const strings = decoded.stringPool.strings;
    const format = {
        nodes: (nodes, indent) => {
            return nodes.map(node => format.node(node, indent)).join('\n');
        },
        node: (node, indent) => {
            const parts = [indent, '<', strings[node.nameId]];
            for (let ns of node.namespaces.filter(ns => ns.node === node)) {
                parts.push(' ', `xmlns:${strings[ns.nameId]}="${strings[ns.valueId]}"`);
            }
            const attr_indent = node.attributes.length > 1 ? `\n${indent}   ` : ' ';
            for (let attr of node.attributes) {
                parts.push(attr_indent, format.attribute(attr, node.namespaces));
            }
            if (node.nodes.length) {
                parts.push('>\n', format.nodes(node.nodes, indent + '  '), '\n', indent, '</', strings[node.nameId], '>');
            } else {
                parts.push(' />');
            }

            return parts.join('');
        },
        attribute: (attr, namespaces) => {
            let value = attr.value;
            switch (attr.type) {
                case 3:
                    value = strings[value];
                    break;
                case 16:
                    value |= 0; // convert to signed integer
                    break; 
                case 18:
                    value = value ? true : false;
                    break;
                case 1: // resource id
                case 17: // flags
                default:
                    value = '0x' + value.toString(`16`);
                    break;
            }
            let ns = '';
            if (attr.ns >= 0) {
                ns = `${strings[namespaces.find(ns => ns.valueId === attr.ns).nameId]}:`;
            }
            return `${ns}${strings[attr.nameId]}="${value}"`;
        }
    }
    return '<?xml version="1.0" encoding="utf-8"?>\n' + format.nodes(decoded.nodes, '');
}

module.exports = {
    decode_binary_xml,
}
