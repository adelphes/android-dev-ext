const { D, E } = require('./utils/print');
const {
	DebuggerMethodInfo,
	DebuggerTypeInfo,
	JavaTaggedValue,
} = require('./debugger-types');
const { JavaType } = require('./debugger-types');

/** the next command ID */
let gCommandId = 0;

/**
 * The in-progress JDWP commands, mapped by ID
 * @type {Map<number,Command>}
 */
const gCommandList = new Map();

/**
 * The list of registered JDWP event callback objects, mapped by ID.
 * These are called when JDWP sends a composite event, triggered by a breakpoint, exception or class-prepare.
 * @type {Map<number,*>}
 */
const gEventCallbacks = new Map();

/**
 * The singleton instance of the `DataCoderClass`, initialised after the Java Object ID sizes are retrieved.
 * @type {DataCoderClass}
 **/
let DataCoder;

/**
 * Class representing a single JDWP command
 */
class Command {
		
	/**
	 * @param {string} name 
	 * @param {byte} commandset 
	 * @param {byte} command 
	 * @param {()=>byte[]} outdatafn 
	 * @param {(o)=>*} [replydecodefn] 
	 */
	constructor(name, commandset, command, outdatafn, replydecodefn) {
		this.length = 11;
		this.id = ++gCommandId;
		this.flags = 0;
		this.commandset = commandset;
		this.command = command;
		this.rawdata = outdatafn ? outdatafn() : [];

		this.length = 11 + this.rawdata.length;
		gCommandList.set(this.id, this);

		this.name = name;
		this.replydecodefn = replydecodefn;
	}

	/**
	 * Return a buffer with the raw JDWP command bytes
	 */
	toBuffer() {
		const buf = Buffer.allocUnsafe(11 + this.rawdata.length);
		buf.writeUInt32BE(this.length, 0);
		buf.writeUInt32BE(this.id, 4);
		buf[8] = this.flags;
		buf[9] = this.commandset;
		buf[10] = this.command;
		if (this.rawdata.length) {
			Buffer.from(this.rawdata).copy(buf, 11);
		}
		return buf;
	}
}

/**
 * Class representing a single JDWP reply
 */
class Reply {
		
	/**
	 * @param {Buffer} s 
	 */
	constructor(s) {
		this.length = s.readUInt32BE(0);
		this.id = s.readUInt32BE(4);
		this.flags = s[8];
		this.errorcode = s.readUInt16BE(9);
		this.rawdata = s.slice(11);
		// look up the matching command by ID
		this.command = gCommandList.get(this.id);
		gCommandList.delete(this.id);
		this.isevent = false;
		
		if (this.errorcode === 16484) {
			//	errorcode===16484 (0x4064) means a composite event command (set 64,cmd 100) sent from the VM
			this.errorcode = 0;
			this.isevent = true;
			this.handleCompositeEvent();
			return;
		}
	
		if (this.errorcode === 50945) {
			// errorcode===50945 (0xC701) refers to a DDM chunk (set 199, cmd 1) for a
			// previous command. It's unclear why these are being sent but it appears 
			// they're safe to ignore.
			//
			// see https://android.googlesource.com/platform/art/+/master/adbconnection/adbconnection.cc
			this.decoded = {
				empty: true,
				errorcode: 0
			}
			return;
		}

		if (this.errorcode !== 0) {
			// https://docs.oracle.com/javase/7/docs/platform/jpda/jdwp/jdwp-protocol.html#JDWP_Error
			if (this.command !== undefined) {
				E(`JDWP command failed '${this.command.name}'. Error ${this.errorcode}`, this);
			} else {
				E(`Unknown JDWP command with id '${this.id}' failed. Error ${this.errorcode}`, this);
			}
		}
		
		if (!this.errorcode && this.command && this.command.replydecodefn) {
			// try and decode the values
			this.decoded = this.command.replydecodefn({
				idx: 0,
				data: this.rawdata,
			});
			return;
		}

		this.decoded = {
			empty: true,
			errorcode: this.errorcode,
		};
	}

	handleCompositeEvent() {
		this.decoded = DataCoder.decodeCompositeEvent({
			idx: 0,
			data: this.rawdata,
		});
		// call any registered event callbacks
		this.decoded.events.forEach(event => {
			const cbinfo = event.reqid && gEventCallbacks.get(event.reqid);
			if (cbinfo) {
				const e = { 
					data: cbinfo.callback.data,
					event,
					reply: this,
				};
				cbinfo.callback.fn.call(cbinfo.callback.ths, e);
			}
		});
	}
}

/**
 * JDWP data decoder class
 */

class DataCoderClass {

	constructor(id_sizes) {
		this.id_sizes = id_sizes;
		this.null_ref_type_id = '00'.repeat(id_sizes.reftypeidsize);
	}

	nullRefValue() {
		return this.null_ref_type_id;
	}

	decodeString(o) {
		let utf8len = o.data.readUInt32BE((o.idx += 4) - 4);
		if (utf8len > 10000) {
			utf8len = 10000;	// just to prevent hangs if the decoding is wrong
		}
		return o.data.slice(o.idx, o.idx += utf8len).toString();
	}

	decodeLong(o) {
		const res1 = o.data.readUInt32BE((o.idx += 4) - 4);
		const res2 = o.data.readUInt32BE((o.idx += 4) - 4);
		return `${res1.toString(16).padStart(8,'0')}${res2.toString(16).padStart(8,'0')}`;
	}

	decodeInt(o) {
		return o.data.readInt32BE((o.idx += 4) - 4);
	}

	decodeShort(o) {
		return o.data.readInt16BE((o.idx += 2) - 2);
	}

	decodeByte(o) {
		return o.data.readInt8(o.idx++);
	}

	decodeChar(o) {
		return o.data.readUInt16BE((o.idx += 2) - 2);
	}

	decodeBoolean(o) {
		return o.data[o.idx++] !== 0;
	}

	decodeDecimal(bytes, signBits, exponentBits, fractionBits, eMin, eMax, littleEndian) {
		let byte_bits = bytes.map(byte => `0000000${byte.toString(2)}`.slice(-8));
		if (littleEndian) {
			byte_bits = byte_bits.reverse();
		}
		const binary = byte_bits.join('');

		const sign = (binary[0] === '1') ? -1 : 1;
		let exponent = parseInt(binary.substr(signBits, exponentBits), 2) - eMax;
		const significandBase = binary.substr(signBits + exponentBits, fractionBits);
		let significandBin = `1${significandBase}`;
		let val = 1;
		let significand = 0;

		if (exponent+eMax === ((eMax*2)+1)) {
			if (significandBase.indexOf('1') < 0) {
				return sign > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
			}
			return Number.NaN;
		}
		if (exponent === -eMax) {
			if (significandBase.indexOf('1') === -1) {
				return 0;
			}
			exponent = eMin;
			significandBin = `0${significandBase}`;
		}

		for (let bit of significandBin) {
		  significand += val * parseInt(bit,2);
		  val = val / 2;
		}

		return sign * significand * Math.pow(2, exponent);
	}

	decodeFloat(o) {
		const bytes = o.data.slice(o.idx, o.idx+=4);
		return this.decodeDecimal(bytes, 1, 8, 23, -126, 127, false);
	}

	decodeDouble(o) {
		const bytes = o.data.slice(o.idx, o.idx+=8);
		return this.decodeDecimal(bytes, 1, 11, 52, -1022, 1023, false);
	}

	decodeRef(o, bytes) {
		return o.data.slice(o.idx, o.idx += bytes).toString('hex');
	}

	decodeTRef(o) {
		return this.decodeRef(o,this.id_sizes.reftypeidsize);
	}

	decodeORef(o) {
		return this.decodeRef(o,this.id_sizes.objectidsize);
	}

	decodeMRef(o) {
		return this.decodeRef(o,this.id_sizes.methodidsize);
	}

	decodeRefType (o) {
		return DataCoderClass.mapValue(this.decodeByte(o), [null,'class','interface','array']);
	}

	decodeStatus (o) {
		return DataCoderClass.mapFlags(this.decodeInt(o), ['verified','prepared','initialized','error']);
	}

	decodeThreadStatus(o) {
		return ['zombie','running','sleeping','monitor','wait'][this.decodeInt(o)] || '';
	}

	decodeSuspendStatus(o) {
		return this.decodeInt(o) ? 'suspended': '';
	}

	decodeTaggedObjectID(o) {
		return this.decodeValue(o);
	}

	decodeValue(o) {
		return this.tagtoDecoder(o.data[o.idx++]).call(this, o);
	}

	tagtoDecoder(tag) {
		switch (tag) {
			case 91: 
			case 76: 
			case 115:
			case 116:
			case 103:
			case 108:
			case 99:
				return this.decodeORef;
			case 66:
				return this.decodeByte;
			case 90:
				return this.decodeBoolean;
			case 67:
				return this.decodeChar;
			case 83:
				return this.decodeShort;
			case 70:
				return this.decodeFloat;
			case 73:
				return this.decodeInt;
			case 68:
				return this.decodeDouble;
			case 74:
				return this.decodeLong;
			case 86:
				return function() { return 'void'; };
		}
	}

	static mapValue(value,values) {
		return {value: value, string:values[value] };
	}

	static mapFlags(value,values) {
		const res = {
			value,
			string:'[]',
		};
		const flgs = [];
		for (let i = value,j = 0; i; i>>=1) {
			if ((i&1)&&(values[j]))
				flgs.push(values[j]);
			j++;
		}
		res.string = '['+flgs.join('|')+']';
		return res;
	}

	decodeList(o, list) {
		const res = {};
		while (list.length) {
			const next = list.shift();
			for ( let key in next) {
				switch(next[key]) {
					case 'string': res[key]=this.decodeString(o); break;
					case 'int': res[key]=this.decodeInt(o); break;
					case 'long': res[key]=this.decodeLong(o); break;
					case 'byte': res[key]=this.decodeByte(o); break;
					case 'fref': res[key]=this.decodeRef(o,this.id_sizes.fieldidsize); break;
					case 'mref': res[key]=this.decodeRef(o,this.id_sizes.methodidsize); break;
					case 'oref': res[key]=this.decodeRef(o,this.id_sizes.objectidsize); break;
					case 'tref': res[key]=this.decodeRef(o,this.id_sizes.reftypeidsize); break;
					case 'frameid': res[key]=this.decodeRef(o,this.id_sizes.frameidsize); break;
					case 'reftype': res[key]=this.decodeRefType(o); break;
					case 'status': res[key]=this.decodeStatus(o); break;
					case 'location': res[key]=this.decodeLocation(o); break;
					case 'signature': res[key]=this.decodeTypeFromSignature(o); break;
					case 'codeindex': res[key]=this.decodeLong(o); break;
				}
			}
		}
		return res;
	}

	decodeLocation(o) {
		return { 
			type: o.data[o.idx++],
			cid: this.decodeTRef(o),
			mid: this.decodeMRef(o),
			idx: this.decodeLong(o),
		};
	}

	decodeTypeFromSignature(o) {
		const signature = this.decodeString(o);
		return JavaType.from(signature);
	}

	decodeCompositeEvent(o) {
		const rd = o.data;
		const res = {};
		res.suspend = rd[o.idx++];
		res.events = [];
		let arrlen = this.decodeInt(o);
		while (--arrlen >= 0) {
			// all event types return kind+requestid as their first entries
			const event = { 
				kind:{
					name:'',
					value:rd[o.idx++],
				}

			};
			const eventkinds = ['','step','breakpoint','framepop','exception','userdefined','threadstart','threadend','classprepare','classunload','classload'];
			event.kind.name = eventkinds[event.kind.value];
			switch(event.kind.value) {
				case 1: // step
				case 2: // breakpoint
					event.reqid = this.decodeInt(o);
					event.threadid = this.decodeORef(o);
					event.location = this.decodeLocation(o);
					break;
				case 4: // exception
					event.reqid = this.decodeInt(o);
					event.threadid = this.decodeORef(o);
					event.throwlocation = this.decodeLocation(o);
					event.exception = this.decodeTaggedObjectID(o);
					event.catchlocation = this.decodeLocation(o);	// 0 = uncaught
					break;
				case 6: // thread start
				case 7: // thread end
					event.reqid = this.decodeInt(o);
					event.threadid = this.decodeORef(o);
					event.state = event.kind.value === 6 ? 'start' : 'end';
					break;
				case 8: // classprepare
					event.reqid = this.decodeInt(o);
					event.threadid = this.decodeORef(o);
					event.reftype = this.decodeByte(o);
					event.typeid = this.decodeTRef(o);
					event.type = this.decodeTypeFromSignature(o);
					event.status = this.decodeStatus(o);
					break;
			}
			res.events.push(event);
		}
		return res;
	}


	/**
	 * @param {byte[]} res 
	 * @param {number} i 
	 */
	encodeByte(res, i) {
		res.push(i&255);
	}


	/**
	 * @param {byte[]} res 
	 * @param {boolean} b 
	 */
	encodeBoolean(res, b) {
		res.push(b?1:0);
	}


	/**
	 * @param {byte[]} res 
	 * @param {number} i 
	 */
	encodeShort(res, i) {
		res.push((i>>8)&255);
		res.push((i)&255);
	}


	/**
	 * @param {byte[]} res 
	 * @param {number} i 
	 */
	encodeInt(res, i) {
		res.push((i>>24)&255);
		res.push((i>>16)&255);
		res.push((i>>8)&255);
		res.push((i)&255);
	}


	/**
	 * @param {byte[]} res 
	 * @param {number|string} c 
	 */
	encodeChar(res, c) {
		// c can either be a 1 char string or an integer
		this.encodeShort(res, typeof c === 'string' ? c.charCodeAt(0) : c);
	}


	/**
	 * @param {byte[]} res 
	 * @param {string} s 
	 */
	encodeString(res, s) {
		const utf8_bytes = Buffer.from(s, 'utf8');
		this.encodeInt(res, utf8_bytes.length);
		for (let i = 0; i < utf8_bytes.length; i++)
			res.push(utf8_bytes[i]);
	}


	/**
	 * @param {byte[]} res 
	 * @param {JavaRefID} ref 
	 */
	encodeRef(res, ref) {
		if (ref === null) {
			ref = this.nullRefValue();
		}
		for(let i = 0; i < ref.length; i+=2) {
			res.push(parseInt(ref.substring(i,i+2), 16));
		}
	}


	/**
	 * @param {byte[]} res 
	 * @param {string} l 
	 */
	encodeLong(res, l) {
		for(let i = 0; i < l.length; i+=2) {
			res.push(parseInt(l.substring(i,i+2), 16));
		}
	}


	/**
	 * @param {byte[]} res 
	 * @param {number|string} value
	 */
	encodeDouble(res, value) {
		if (typeof value === 'string') {
			value = (parseInt(value.slice(0,-12),16) * Math.pow(2,48)) + (parseInt(value.slice(-12),16));
		}
		let hiWord = 0, loWord = 0;
		switch (value) {
			case Number.POSITIVE_INFINITY: hiWord = 0x7FF00000; break;
			case Number.NEGATIVE_INFINITY: hiWord = 0xFFF00000; break;
			case +0.0: hiWord = 0x00000000; break;//0x40000000; break;
			case -0.0: hiWord = 0x80000000; break;//0xC0000000; break;
			default:
				if (Number.isNaN(value)) { hiWord = 0x7FF80000; break; }

				if (value <= -0.0) {
					hiWord = 0x80000000;
					value = -value;
				}

				let exponent = Math.floor(Math.log(value) / Math.log(2));
				let significand = Math.floor((value / Math.pow(2, exponent)) * Math.pow(2, 52));

				loWord = significand & 0xFFFFFFFF;
				significand /= Math.pow(2, 32);

				exponent += 1023;
				if (exponent >= 0x7FF) {
					exponent = 0x7FF;
					significand = 0;
				} else if (exponent < 0) exponent = 0;

				hiWord = hiWord | (exponent << 20);
				hiWord = hiWord | (significand & ~(-1 << 20));
			break;
		}
		this.encodeInt(res, hiWord);
		this.encodeInt(res, loWord);
	}


	/**
	 * @param {byte[]} res 
	 * @param {number|string} value 
	 */
	encodeFloat(res, value) {
		if (typeof value === 'string') {
			value = (parseInt(value.slice(0,-12),16) * Math.pow(2,48)) + (parseInt(value.slice(-12),16));
		}
		let bytes = 0;
		switch (value) {
			case Number.POSITIVE_INFINITY: bytes = 0x7F800000; break;
			case Number.NEGATIVE_INFINITY: bytes = 0xFF800000; break;
			case +0.0: bytes = 0x00000000; break;//0x40000000; break;
			case -0.0: bytes = 0x80000000; break;//0xC0000000l
			default:
				if (Number.isNaN(value)) { bytes = 0x7FC00000; break; }

				if (value <= -0.0) {
					bytes = 0x80000000;
					value = -value;
				}

				let exponent = Math.floor(Math.log(value) / Math.log(2));
				let significand = ((value / Math.pow(2, exponent)) * 0x00800000) | 0;

				exponent += 127;
				if (exponent >= 0xFF) {
					exponent = 0xFF;
					significand = 0;
				} else if (exponent < 0) exponent = 0;

				bytes = bytes | (exponent << 23);
				bytes = bytes | (significand & ~(-1 << 23));
			break;
		}

		this.encodeInt(res, bytes);
	}


	/**
	 * @param {byte[]} res 
	 * @param {JavaValueType} valuetype 
	 * @param {*} data 
	 */
	encodeValue(res, valuetype, data) {
		switch(valuetype) {
			case 'byte': this.encodeByte(res, data); break;
			case 'short': this.encodeShort(res, data); break;
			case 'int': this.encodeInt(res, data); break;
			case 'long': this.encodeLong(res, data); break;
			case 'boolean': this.encodeBoolean(res, data); break;
			case 'char': this.encodeChar(res, data); break;
			case 'float': this.encodeFloat(res, data); break;
			case 'double': this.encodeDouble(res, data); break;
			// note that strings are encoded as object references...
			case 'oref': this.encodeRef(res,data); break;
			default:
				D(`invalid value type: ${valuetype} - assuming oref`);
				this.encodeRef(res,data); break;
		}
	}



	/**
	 * @param {byte[]} res 
	 * @param {JavaValueType} valuetype 
	 * @param {*} value 
	 */
	encodeTaggedValue(res, valuetype, value) {
		switch(valuetype) {
			case 'byte': res.push(66); break;
			case 'short': res.push(83); break;
			case 'int':  res.push(73); break;
			case 'long': res.push(74); break;
			case 'boolean': res.push(90); break;
			case 'char': res.push(67); break;
			case 'float': res.push(70); break;
			case 'double': res.push(68); break;
			case 'void': res.push(86); break;
			// note that strings are encoded as object references...
			case 'oref': res.push(76); break;
			default:
				D(`invalid tagged value type: ${valuetype} - assuming oref`);
				res.push(76); break;
			}
		this.encodeValue(res, valuetype, value);
	}

};

/**
 * JDWP - The Java Debug Wire Protocol
 */
class JDWP {

	static decodeReply(buffer) {
		const reply = new Reply(buffer);
		return reply;
	};
	
	static initDataCoder(idsizes) {
		DataCoder = new DataCoderClass(idsizes);
	}

	static Commands = {
		version() {
			return new Command('version',1, 1,
				null,
				function (o) {
					return DataCoder.decodeList(o, [{description:'string'},{major:'int'},{minor:'int'},{version:'string'},{name:'string'}]);
				}
			);
		},
		idsizes() {
			return new Command('IDSizes', 1, 7,
				function() {
					return [];
				},
				function(o) {
					const ints = [];
					for (let i = 0; i < o.data.length; i += 4) {
						ints.push((o.data[i]<<24) + (o.data[i+1]<<16) + (o.data[i+2]<<8) + (o.data[i+3]));
					}
					const [fieldidsize,methodidsize,objectidsize,reftypeidsize,frameidsize] = ints;
					return {
						fieldidsize,
						methodidsize,
						objectidsize,
						reftypeidsize,
						frameidsize,
					}
				}
			);
		},

		/**
		 * 
		 * @param {string} signature
		 */
		classinfo(signature) {
			return new Command('ClassesBySignature:'+signature, 1, 2,
				function() {
					const res = [];
					DataCoder.encodeString(res, signature);
					return res;
				},
				function(o) {
					let arrlen = DataCoder.decodeInt(o);
					const res = [];
					while (--arrlen >= 0) {
						res.push(DataCoder.decodeList(o, [{reftype:'reftype'},{typeid:'tref'},{status:'status'}]));
					}
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {DebuggerTypeInfo} ci 
		 */
		fields:function(ci) {
    		// not supported by Dalvik
			return new Command('Fields:'+ci.name, 2, 4,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					let arrlen = DataCoder.decodeInt(o);
					const res = [];
					while (--arrlen >= 0) {
						res.push(DataCoder.decodeList(o, [{fieldid:'fref'},{name:'string'},{sig:'string'},{modbits:'int'}]));
					}
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {DebuggerTypeInfo} ci 
		 */
		methods:function(ci) {
    		// not supported by Dalvik - use methodsWithGeneric
			return new Command('Methods:'+ci.name, 2, 5,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					let arrlen = DataCoder.decodeInt(o);
					const res = [];
					while (--arrlen >= 0) {
						res.push(DataCoder.decodeList(o, [{methodid:'mref'},{name:'string'},{sig:'string'},{modbits:'int'}]));
					}
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {JavaTypeID} typeid 
		 * @param {*[]} fields 
		 */
		GetStaticFieldValues(typeid, fields) {
			return new Command('GetStaticFieldValues:'+typeid, 2, 6,
				function() {
					const res = [];
					DataCoder.encodeRef(res, typeid);
					DataCoder.encodeInt(res, fields.length);
					for (const i in fields) {
						DataCoder.encodeRef(res, fields[i].fieldid);
					}
					return res;
				},
				function(o) {
					const res = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
    					const v = DataCoder.decodeValue(o);
					    res.push(v);
					}
					return res;
				}
			);
		},

		/**
		 * @param {DebuggerTypeInfo} ci 
		 */
		sourcefile(ci) {
			return new Command('SourceFile:'+ci.name, 2, 7,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					return [{'sourcefile':DataCoder.decodeString(o)}];
				}
			);
		},

		/**
		 * @param {DebuggerTypeInfo} ci 
		 */
		fieldsWithGeneric(ci) {
			return new Command('FieldsWithGeneric:'+ci.name, 2, 14,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					let arrlen = DataCoder.decodeInt(o);
					/** @type {JavaField[]} */
					const res = [];
					while (--arrlen >= 0) {
						/** @type {JavaField} */
						// @ts-ignore
						const field = DataCoder.decodeList(o, [{fieldid:'fref'},{name:'string'},{type:'signature'},{genericsig:'string'},{modbits:'int'}]);
						res.push(field);
					}
					return res;
				}
			);
		},

		/**
		 * @param {DebuggerTypeInfo} ci 
		 */
		methodsWithGeneric(ci) {
			return new Command('MethodsWithGeneric:'+ci.name, 2, 15,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					let arrlen = DataCoder.decodeInt(o);
					const res = [];
					while (--arrlen >= 0) {
						res.push(DataCoder.decodeList(o, [{methodid:'mref'},{name:'string'},{sig:'string'},{genericsig:'string'},{modbits:'int'}]));
					}
					return res;
				}
			);
		},

		/**
		 * @param {DebuggerTypeInfo} ci 
		 */
		superclass(ci) {
			return new Command('Superclass:'+ci.name, 3, 1,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					return DataCoder.decodeTRef(o);
				}
			);
		},

		/**
		 * @param {JavaTypeID} typeid
		 */
		signature(typeid) {
			return new Command('Signature:'+typeid, 2, 1,
				function() {
					const res = [];
					DataCoder.encodeRef(res, typeid);
					return res;
				},
				function(o) {
					return DataCoder.decodeTypeFromSignature(o);
				}
			);
		},

		/**
		 * nestedTypes is not implemented on android
		 * @param {DebuggerTypeInfo} ci 
		 */
		nestedTypes(ci) {
			return new Command('NestedTypes:'+ci.name, 2, 8,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					return res;
				},
				function(o) {
					const res = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
    					const v = DataCoder.decodeList(o, [{reftype:'reftype'},{typeid:'tref'}]);
					    res.push(v);
					}
					return res;
				}
			);
		},

		/**
		 * @param {DebuggerTypeInfo} ci 
		 * @param {DebuggerMethodInfo} mi 
		 */
		lineTable(ci, mi) {
			return new Command('Linetable:'+ci.name+","+mi.name, 6, 1,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					DataCoder.encodeRef(res, mi.methodid);
					return res;
				},
				function(o) {
					const res = {};
					res.start = DataCoder.decodeLong(o);
					res.end = DataCoder.decodeLong(o);
					res.lines = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
    					const line = DataCoder.decodeList(o, [{linecodeidx:'codeindex'},{linenum:'int'}]);
					    res.lines.push(line);
					}
					// sort the lines by...um..line number
					res.lines.sort(function(a,b) {
						return a.linenum-b.linenum
							|| a.linecodeidx-b.linecodeidx;
					})
					return res;
				}
			);
		},

		/**
		 * @param {DebuggerTypeInfo} ci 
		 * @param {DebuggerMethodInfo} mi 
		 */
		VariableTableWithGeneric(ci, mi) {
		    // VariableTable is not supported by Dalvik
			return new Command('VariableTableWithGeneric:'+ci.name+","+mi.name, 6, 5,
				function() {
					const res = [];
					DataCoder.encodeRef(res, ci.info.typeid);
					DataCoder.encodeRef(res, mi.methodid);
					return res;
				},
				function(o) {
					 /** @type {JavaVarTable} */
					const res = {};
					res.argCnt = DataCoder.decodeInt(o);
					res.vars = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
						/** @type {JavaVar} */
						// @ts-ignore
    					const v = DataCoder.decodeList(o, [{codeidx:'codeindex'},{name:'string'},{type:'signature'},{genericsig:'string'},{length:'int'},{slot:'int'}]);
					    res.vars.push(v);
					}
					return res;
				}
			);
		},

		/**
		 * @param {JavaThreadID} threadid
		 * @param {number} start
		 * @param {number} count
		 */
		Frames(threadid, start = 0, count = -1) {
			return new Command('Frames:'+threadid, 11, 6,
				function() {
					const res = [];
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeInt(res, start);
					DataCoder.encodeInt(res, count);
					return res;
				},
				function(o) {
					/** @type {JavaFrame[]} */
					const res = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
						/** @type {JavaFrame} */
						// @ts-ignore
    					const v = DataCoder.decodeList(o, [{frameid:'frameid'},{location:'location'}]);
					    res.push(v);
					}
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {JavaThreadID} threadid 
		 * @param {JavaFrameID} frameid 
		 * @param {*[]} slots 
		 */
		GetStackValues(threadid, frameid, slots) {
			return new Command('GetStackValues:'+threadid, 16, 1,
				function() {
					const res = [];
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeRef(res, frameid);
					DataCoder.encodeInt(res, slots.length);
					for (const i in slots) {
						DataCoder.encodeInt(res, slots[i].slot);
						DataCoder.encodeByte(res, slots[i].tag);
					}
					return res;
				},
				function(o) {
					const res = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
    					const v = DataCoder.decodeValue(o);
					    res.push(v);
					}
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {JavaThreadID} threadid 
		 * @param {JavaFrameID} frameid 
		 * @param {number} slot 
		 * @param {JavaTaggedValue} data 
		 */
		SetStackValue(threadid, frameid, slot, data) {
			return new Command('SetStackValue:'+threadid, 16, 2,
				function() {
					const res = [];
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeRef(res, frameid);
					DataCoder.encodeInt(res, 1);
					DataCoder.encodeInt(res, slot);
					DataCoder.encodeTaggedValue(res, data.valuetype, data.value);
					return res;
				},
				function() {
					// there's no return data - if we reach here, the update was successfull
					return true;
				}
			);
		},

		/**
		 * @param {JavaObjectID} objectid
		 */
		GetObjectType(objectid) {
			return new Command('GetObjectType:'+objectid, 9, 1,
				function() {
					const res = [];
					DataCoder.encodeRef(res, objectid);
					return res;
				},
				function(o) {
					DataCoder.decodeRefType(o);
					return DataCoder.decodeTRef(o);
				}
			);
		},

		/**
		 * 
		 * @param {JavaObjectID} objectid 
		 * @param {JavaField[]} fields 
		 */
		GetFieldValues(objectid, fields) {
			return new Command('GetFieldValues:'+objectid, 9, 2,
				function() {
					const res = [];
					DataCoder.encodeRef(res, objectid);
					DataCoder.encodeInt(res, fields.length);
					for (const i in fields) {
						DataCoder.encodeRef(res, fields[i].fieldid);
					}
					return res;
				},
				function(o) {
					const res = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
    					const v = DataCoder.decodeValue(o);
					    res.push(v);
					}
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {JavaObjectID} objectid 
		 * @param {*} field 
		 * @param {*} data 
		 */
		SetFieldValue(objectid, field, data) {
			return new Command('SetFieldValue:'+objectid, 9, 3,
				function() {
					const res = [];
					DataCoder.encodeRef(res, objectid);
					DataCoder.encodeInt(res, 1);
					DataCoder.encodeRef(res, field.fieldid);
					DataCoder.encodeValue(res, data.valuetype, data.value);
					return res;
				},
				function() {
					// there's no return data - if we reach here, the update was successful
					return true;
				}
			);
		},

		/**
		 * 
		 * @param {JavaObjectID} objectid 
		 * @param {JavaThreadID} threadid 
		 * @param {JavaClassID} classid 
		 * @param {JavaMethodID} methodid 
		 * @param {JavaTaggedValue[]} args 
		 */
		InvokeMethod(objectid, threadid, classid, methodid, args) {
			return new Command('InvokeMethod:'+[objectid, threadid, classid, methodid, args].join(','), 9, 6,
				function() {
					const res = [];
					DataCoder.encodeRef(res, objectid);
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeRef(res, classid);
					DataCoder.encodeRef(res, methodid);
					DataCoder.encodeInt(res, args.length);
					args.forEach(arg => DataCoder.encodeTaggedValue(res, arg.valuetype, arg.value));
					DataCoder.encodeInt(res, 1);	// INVOKE_SINGLE_THREADED
					return res;
				},
				function(o) {
					return {
						return_value: DataCoder.decodeValue(o),
						exception: DataCoder.decodeTaggedObjectID(o),
					}
				}
			);
		},

		/**
		 * @param {JavaThreadID} threadid 
		 * @param {JavaClassID} classid 
		 * @param {JavaMethodID} methodid 
		 * @param {JavaTaggedValue[]} args 
		 */
		InvokeStaticMethod(threadid, classid, methodid, args) {
			return new Command('InvokeStaticMethod:'+[threadid, classid, methodid, args].join(','), 3, 3,
				function() {
					const res = [];
					DataCoder.encodeRef(res, classid);
					DataCoder.encodeRef(res, threadid);
					DataCoder.encodeRef(res, methodid);
					DataCoder.encodeInt(res, args.length);
					args.forEach(arg => DataCoder.encodeTaggedValue(res, arg.valuetype, arg.value));
					DataCoder.encodeInt(res, 1);	// INVOKE_SINGLE_THREADED
					return res;
				},
				function(o) {
					return {
						return_value: DataCoder.decodeValue(o),
						exception: DataCoder.decodeTaggedObjectID(o),
					}
				}
			);
		},

		/**
		 * @param {JavaObjectID} arrobjid 
		 */
		GetArrayLength(arrobjid) {
			return new Command('GetArrayLength:'+arrobjid, 13, 1,
				function() {
					const res = [];
					DataCoder.encodeRef(res, arrobjid);
					return res;
				},
				function(o) {
					return DataCoder.decodeInt(o);
				}
			);
		},

		/**
		 * 
		 * @param {JavaObjectID} arrobjid 
		 * @param {number} idx 
		 * @param {number} count 
		 */
		GetArrayValues(arrobjid, idx, count) {
			return new Command('GetArrayValues:'+arrobjid, 13, 2,
				function() {
					const res = [];
					DataCoder.encodeRef(res, arrobjid);
					DataCoder.encodeInt(res, idx);
					DataCoder.encodeInt(res, count);
					return res;
				},
				function(o) {
					const res = [];
					const tag = DataCoder.decodeByte(o);
					let decodefn = DataCoder.tagtoDecoder(tag);
					// objects are decoded as values
					if (decodefn === DataCoder.decodeORef) {
						decodefn = DataCoder.decodeValue;
					}
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
    					const v = decodefn.call(DataCoder, o);
					    res.push(v);
					}
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {JavaObjectID} arrobjid 
		 * @param {number} idx 
		 * @param {number} count 
		 * @param {JavaTaggedValue} data 
		 */
		SetArrayElements(arrobjid, idx, count, data) {
			return new Command('SetArrayElements:'+arrobjid, 13, 3,
				function() {
					const res = [];
					DataCoder.encodeRef(res, arrobjid);
					DataCoder.encodeInt(res, idx);
					DataCoder.encodeInt(res, count);
					for (let i = 0; i < count; i++)
						DataCoder.encodeValue(res, data.valuetype, data.value);
					return res;
				},
				function() {
					// there's no return data - if we reach here, the update was successfull
					return true;
				}
			);
		},

		/**
		 * 
		 * @param {JavaObjectID} strobjid 
		 */
		GetStringValue(strobjid) {
			return new Command('GetStringValue:'+strobjid, 10, 1,
				function() {
					const res = [];
					DataCoder.encodeRef(res, strobjid);
					return res;
				},
				function(o) {
					return DataCoder.decodeString(o);
				}
			);
		},

		/**
		 * 
		 * @param {string} text 
		 */
		CreateStringObject(text) {
			return new Command('CreateStringObject:'+text.substring(0,20), 1, 11,
				function() {
					const res = [];
					DataCoder.encodeString(res, text);
					return res;
				},
				function(o) {
					return DataCoder.decodeORef(o);
				}
			);
		},

		/**
		 * 
		 * @param {string} kindname 
		 * @param {byte} kind 
		 * @param {byte} suspend 
		 * @param {*[]} modifiers 
		 * @param {(a,b,c) => void} modifiercb 
		 * @param {(o) => void} onevent 
		 */
		SetEventRequest(kindname, kind, suspend, modifiers, modifiercb, onevent) {
			return new Command('SetEventRequest:'+kindname, 15, 1,
				function() {
					const res = [kind, suspend];
					DataCoder.encodeInt(res, modifiers.length);
					for (let i = 0; i < modifiers.length; i++) {
                        modifiercb(modifiers[i], i, res);
					}
					return res;
				},
				function(o) {
					const res = {
						id: DataCoder.decodeInt(o),
						callback: onevent,
					};
					gEventCallbacks.set(res.id, res);
					D('Accepted event request: '+kindname+', id:'+res.id);
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {string} kindname 
		 * @param {byte} kind 
		 * @param {number} requestid 
		 */
		ClearEvent(kindname, kind, requestid) {
			return new Command('ClearEvent:'+kindname, 15, 2,
				function() {
					const res = [kind];
					DataCoder.encodeInt(res, requestid);
					D('Clearing event request: '+kindname+', id:'+requestid);
					return res;
				}
			);
		},

		/**
		 * 
		 * @param {DebuggerStepType} steptype 
		 * @param {JavaThreadID} threadid 
		 * @param {*} onevent 
		 */
		SetSingleStep(steptype, threadid, onevent) {
			// a wrapper around SetEventRequest
			const stepdepths = {
				into: 0,
				over: 1,
				out: 2,
			};
			const mods = [{
			    modkind: 10, // step
			    threadid: threadid,
			    size: 1,// =Line
			    depth: stepdepths[steptype],
		    }];
			// kind(1=singlestep)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("step",1,1,mods,
			    function(m1, i, res) {
					res.push(m1.modkind);
					DataCoder.encodeRef(res, m1.threadid);
					DataCoder.encodeInt(res, m1.size);
					DataCoder.encodeInt(res, m1.depth);
			    },
			    onevent
			);
		},

		/**
		 * 
		 * @param {DebuggerTypeInfo} ci 
		 * @param {DebuggerMethodInfo} mi 
		 * @param {string} idx 
		 * @param {number|null} hitcount 
		 * @param {*} onevent 
		 */
		SetBreakpoint(ci, mi, idx, hitcount, onevent) {
			// a wrapper around SetEventRequest
			 /**
			 * @type {(LocMod|HitMod)[]}
			 */
			const mods = [{
			    modkind: 7, // location
			    loc: {
					type: ci.info.reftype.value,
					cid: ci.info.typeid,
					mid: mi.methodid,
					idx: idx,
				},
				encode(res) {
					res.push(this.modkind);
					res.push(this.loc.type);
					DataCoder.encodeRef(res, this.loc.cid);
					DataCoder.encodeRef(res, this.loc.mid);
					DataCoder.encodeLong(res, this.loc.idx);
				}
		    }];
			if (hitcount > 0) {
				// remember when setting a hitcount, the event is automatically cancelled after being fired
				mods.unshift({
					modkind: 1,
					count: hitcount,
					encode(res) {
						res.push(this.modkind);
						DataCoder.encodeInt(res, this.count);
					}
				})
			}
			// kind(2=breakpoint)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("breakpoint",2,1,mods,
			    function(m, i, res) {
					m.encode(res,i);
			    },
			    onevent
			);
		},

		/**
		 * 
		 * @param {StepID} requestid 
		 */
		ClearStep(requestid) {
			// kind(1=step)
			return this.ClearEvent("step", 1, requestid);
		},

		/**
		 * 
		 * @param {number} requestid 
		 */
		ClearBreakpoint(requestid) {
			// kind(2=breakpoint)
			return this.ClearEvent("breakpoint",2,requestid);
		},

		/**
		 * 
		 * @param {*} onevent 
		 */
		ThreadStartNotify(onevent) {
			// a wrapper around SetEventRequest
			const mods = [];
			// kind(6=threadstart)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("threadstart",6,1,mods,
			    function() {},
			    onevent
			);
		},

		/**
		 * 
		 * @param {*} onevent 
		 */
		ThreadEndNotify(onevent) {
			// a wrapper around SetEventRequest
			const mods = [];
			// kind(7=threadend)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("threadend",7,1,mods,
			    function() {},
			    onevent
			);
		},

		/**
		 * @param {string} pattern 
		 * @param {*} onevent 
		 */
		OnClassPrepare(pattern, onevent) {
			// a wrapper around SetEventRequest
			const mods = [{
			    modkind: 5, // classmatch
			    pattern,
		    }];
			// kind(8=classprepare)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("classprepare",8,2,mods,
			    function(m1, i, res) {
					res.push(m1.modkind);
					DataCoder.encodeString(res, m1.pattern);
			    },
			    onevent
			);
		},

		/**
		 * 
		 * @param {number} requestid 
		 */
		ClearExceptionBreak(requestid) {
			// kind(4=exception)
			return this.ClearEvent("exception",4,requestid);
		},

		/**
		 * 
		 * @param {string} pattern 
		 * @param {boolean} caught 
		 * @param {boolean} uncaught 
		 * @param {*} onevent 
		 */
		SetExceptionBreak(pattern, caught, uncaught, onevent) {
			// a wrapper around SetEventRequest
			/** @type {(ExOnlyMod|ClassMatchMod)[]} */
			const mods = [{
				modkind: 8,	// exceptiononly
				reftypeid: DataCoder.nullRefValue(),	// exception class
				caught,
				uncaught,
			}];
			pattern && mods.unshift({
				modkind: 5, // classmatch
				pattern,
			});
			// kind(4=exception)
			// suspendpolicy(0=none,1=event-thread,2=all)
			return this.SetEventRequest("exception",4,1,mods,
			    function(m, i, res) {
					res.push(m.modkind);
					switch(m.modkind) {
						case 5: DataCoder.encodeString(res, m.pattern); break;
						case 8:
							DataCoder.encodeRef(res, m.reftypeid);
							DataCoder.encodeBoolean(res, m.caught);
							DataCoder.encodeBoolean(res, m.uncaught);
							break;
					}
			    },
			    onevent
			);
		},

		allclasses() {
			// not supported by android
			throw new Error(`allclasses not supported`);
		},

		AllClassesWithGeneric() {
			return new Command('allclasses',1,20,
				null,
				function(o) {
					const res = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
						res.push(DataCoder.decodeList(o, [{reftype:'reftype'},{typeid:'tref'},{signature:'string'},{genericSignature:'string'},{status:'status'}]));
					}
					return res;
				}
			);
		},

		suspend() {
			return new Command('suspend',1, 8, null, null);
		},

		resume() {
			return new Command('resume',1, 9, null, null);
		},

		/**
		 * 
		 * @param {JavaThreadID} threadid 
		 */
		suspendthread(threadid) {
			return new Command('suspendthread:'+threadid,11, 2, 
				function() {
					const res = [];
					DataCoder.encodeRef(res, threadid);
					return res;
				},
			 	null
			);
		},

		/**
		 * 
		 * @param {JavaThreadID} threadid 
		 */
		resumethread(threadid) {
			return new Command('resumethread:'+threadid,11, 3, 
				function() {
					const res = [];
					DataCoder.encodeRef(res, threadid);
					return res;
				},
			 	null
			);
		},

		allthreads() {
			return new Command('allthreads',1, 4, 
				null, 
				function(o) {
					const res = [];
					let arrlen = DataCoder.decodeInt(o);
					while (--arrlen >= 0) {
						res.push(DataCoder.decodeTRef(o));
					}
					return res;
				}
			);
		},

		/**
		 * @param {JavaThreadID} threadid 
		 */
		threadname(threadid) {
			return new Command('threadname',11,1, 
				function() {
					const res = [];
					DataCoder.encodeRef(res, threadid);
					return res;
				},
				function(o) {
					return DataCoder.decodeString(o);
				}
			);
		},

		/**
		 * @param {JavaThreadID} threadid 
		 */
		threadstatus(threadid) {
			return new Command('threadstatus',11,4, 
				function() {
					const res = [];
					DataCoder.encodeRef(res, threadid);
					return res;
				},
				function(o) {
					return {
						thread: DataCoder.decodeThreadStatus(o),
						suspend: DataCoder.decodeSuspendStatus(o),
					}
				}
			);
		},
	};
}

module.exports = {
	JDWP,
}
