/* TODO
 * - Read pattern names (in the file, the block begins with PNAM. See Load_it.cpp#830-842)
 *   http://modplug.svn.sourceforge.net/viewvc/modplug/trunk/OpenMPT/soundlib/Load_it.cpp?revision=1146&view=markup
 * - Read comment
 * - Pitch bends (requires investigation)
 */

var barryvan = barryvan || {};
barryvan.tp = barryvan.tp || {};

barryvan.tp.Reader = new Class({
	Implements: [Options],
	
	Binds: [
		'_process',
		'_read',
		'_readHeader',
		'_readOrders',
		'_readInstruments',
		'_readInstrument',
		'_readPatterns',
		'_readPattern',
		'toPerformanceData',
		'printPerformanceData',
		'printHeader',
		'printOrders',
		'printInstruments',
		'printPatterns'
	],
	
	options: {
		input: null,
		output: null,
		debug: false,
		print: {
			performance: true,
			header: false,
			orders: false,
			instruments: false,
			patterns: false
		}
	},
	
	_elInput: null,
	_elOutput: null,
	
	_buffer: null,
	_dataview: null,
	
	_parsed: null,
	
	initialize: function(options) {
		if (!(Uint8Array && Uint16Array && Uint32Array)) throw new Exception("Typed arrays needed!");
		
		this.setOptions(options);
		
		this._elInput = $(this.options.input);
		this._elOutput = $(this.options.output);
		
		this._elInput.addEvent('change', this._process);
		this._process();
	},
		
	_process: function() {
		var files = this._elInput.files;
		if (!files) return;
		files = Array.from(files);
		var file = files.pick();
		if (!file) return;
		
		this._elOutput.set('html', '');
		
		this._parsed = {
			header: {},
			orders: [],
			instruments: [],
			patterns: []
		};
		
		var fileReader = new FileReader();
		fileReader.onload = this._read;
		fileReader.readAsArrayBuffer(file);
	},
	
	_read: function(evt) {
		this._buffer = evt.target.result; // ArrayBuffer
		
		this._dataview = new DataView(this._buffer);
		
		this._readHeader();
		this._readOrders();
		this._readInstruments();
		this._readPatterns();
		
		if (this._elOutput) {
			if (this.options.print.performance) this.printPerformanceData();
			if (this.options.print.header) this.printHeader();
			if (this.options.print.orders) this.printOrders();
			if (this.options.print.instruments) this.printInstruments();
			if (this.options.print.patterns) this.printPatterns();
		}
	},
	
	_readHeader: function() {
		var header = {
			name: '',
			beat: this._dataview.getUint8(30),
			measure: this._dataview.getUint8(31),
			numOrders: this._dataview.getUint16(32, true), // little endian
			numInstruments: this._dataview.getUint16(34, true),
			numSamples: this._dataview.getUint16(36, true),
			numPatterns: this._dataview.getUint16(38, true),
			tempo: this._dataview.getUint8(51)
		};
		
		// Song name
		for (var i = 4; i < 30; i++) {
			var c = this._dataview.getUint8(i);
			if (c < 13) break;
			header.name += String.fromCharCode(c);
		}
		
		this._parsed.header = header;
	},
	
	_readOrders: function() {
		var numOrders = this._parsed.header.numOrders;
		
		var offset = 192;
		var orders = [];
		for (var i = 0; i < numOrders; i++) {
			orders[i] = parseInt(this._dataview.getUint8(offset + i), 10);
		}
		
		this._parsed.orders = orders;
	},
	
	_readInstruments: function() {
		var header = this._parsed.header;
		
		var offset = 192 + header.numOrders;
		
		for (var i = 0; i < header.numInstruments; i++) {
			var instrumentOffset = this._dataview.getUint32(offset + (i * 4), true); // little endian
			this._readInstrument(instrumentOffset, i);
		}
	},
	
	_readInstrument: function(offset, number) {
		var name = '';
		for (var i = 0; i < 26; i++) {
			var c = this._dataview.getUint8(offset + 32 + i);
			if (c < 13) break;
			name += String.fromCharCode(c);
		}
		
		if (this.options.debug) this._elOutput.appendText('\n' + 'instrument ' + number + ': ' + name);
		
		this._parsed.instruments.push({
			name: name
		});
	},
	
	_readPatterns: function() {
		var header = this._parsed.header;
		var orders = this._parsed.orders;
		
		var offset = 192
								 + header.numOrders
								 + (header.numInstruments * 4)
								 + (header.numSamples * 4);
		
		for (var i = 0; i < header.numOrders; i++) { // i ==> order number
			var order = orders[i];
			
			if (order === undefined) continue;
			if (order === 254) continue; // +++ skip
			if (order === 255) break; // --- end of song
			
			var index = offset + (order * 4);
			
			var patternOffset = this._dataview.getUint32(index, true); // little endian
			
			this._readPattern(patternOffset, order);
		}
	},
	
	_readPattern: function(offset, orderNumber) {
		var patternData = [];
		var pattern = {
			name: 'Pattern ' + orderNumber,
			rows: patternData
		};
		
		// If the offset to a pattern is 0, then the pattern is assumed
		// to be a 64-row empty pattern.
		if (offset === 0) {
			for (var i = 0; i < 64; i++) {
				patternData.push([]);
			}
			this._parsed.patterns.push(pattern);
			return;
		}
		
		var length = this._dataview.getUint16(offset + 0, true); // Length in bytes, not including 8 byte header (little endian)
		var rowCount = this._dataview.getUint16(offset + 2, true);
		
		offset += 8; // Header is 8 bytes. Now we're into the packed pattern data.
		
		// This is based on Johannes Schultz's modsync.cpp code
		var maskVariable = [], // one per channel
				lastNote = [], // ditto
				lastInstrument = [], // ditto,
				lastEffect = [], // ditto
				lastParameter = [], // ditto
				currentRow = 0,
				channelVariable = null,
				channel = null,
				note = null,
				instrument = null,
				volume = null,
				effect = null,
				parameter = null,
				noteData = null,
				rowData = [];
		while (currentRow < rowCount) {
			if (this.options.debug) this._elOutput.appendText('\n' + '  row ' + currentRow);
			
			channelVariable = this._dataview.getUint8(offset);
			offset += 1;
			if (!channelVariable) { // end of row
				currentRow += 1;
				patternData.push(rowData);
				rowData = [];
				continue;
			}
			
			channel = (channelVariable - 1) & 63;
			if (channelVariable & 128) {
				maskVariable[channel] = this._dataview.getUint8(offset);
				offset += 1;
			}
			
			note = null;
			instrument = null;
			volume = null;
			effect = null;
			parameter = null;
			noteData = null;
			
			if (maskVariable[channel] & 10) {
				note = lastNote[channel] ;
			}
			if (maskVariable[channel] & 20) {
				instrument = lastInstrument[channel];
			}
			if (maskVariable[channel] & 80) {
				effect = lastEffect[channel] || null;
				parameter = lastParameter[channel];
			}
			
			if (maskVariable[channel] & 1) {
				note = this._dataview.getUint8(offset);
				offset += 1;
				lastNote[channel] = note;
			}
			if (maskVariable[channel] & 2) {
				instrument = this._dataview.getUint8(offset);
				offset += 1;
				lastInstrument[channel] = instrument;
			}
			if (maskVariable[channel] & 4) {
				volume = this._dataview.getUint8(offset);
				offset += 1;
			}
			if (maskVariable[channel] & 8) {
				effect = this._dataview.getUint8(offset);
				offset += 1;
				parameter = this._dataview.getUint8(offset);
				offset += 1;
				lastEffect[channel] = effect;
				lastParameter[channel] = parameter;
			}
			
			if (note || instrument) {
				noteData = {
					channel: channel
				};
				if (note === null) note = lastNote[channel];
				if (instrument === null) instrument = lastInstrument[channel];
				if (note !== null) {
					if (note === 255) note = -1; // Note off
					if (note === 254) note = -2; // Note cut
					noteData.note = note;
				}
				if (instrument !== null) {
					noteData.instrument = instrument;
				}
				if (volume !== null) {
					if (volume < 65) { // Volume is in the range 0..64
						noteData.volume = volume;
					} // TODO pitch bends: not in the docs, so will require experimentation.
				}
				rowData.push(noteData);
			}
			
			if (this.options.debug) this._elOutput.appendText('\n' + '    channel ' + channel + ' :: note ' + note + ' :: instrument ' + instrument + ' :: volume ' + volume + ' :: effect ' + effect + ' :: parameter ' + parameter);
		}
		
		this._parsed.patterns.push(pattern);
	},
	
	toPerformanceData: function() {
		var header = this._parsed.header;
		return {
			title: header.name,
			composer: '',
			url: '',
			audio: '',
			comment: '',
			tempo: header.tempo,
			beatRows: header.beat,
			measureRows: header.measure,
			
			prefilters: [],
			postfilters: [],
			
			instruments: this._parsed.instruments.map(function(item) {
				var o = Object.clone(item);
				o.performers = [];
				return o;
			}),
			
			patterns: this._parsed.patterns
		}
	},
	
	printPerformanceData: function() {
		this._elOutput.appendText('\n\n--------------------------------------------------------------\n\n');
		this._elOutput.appendText(JSON.stringify(this.toPerformanceData(), undefined, '\t'));
		this._elOutput.appendText('\n\n--------------------------------------------------------------\n\n');
	},
	
	printHeader: function() {
		this._elOutput.appendText('\n\nHEADER');
		this._elOutput.appendText('\n--------------------------------------------------------------');
		
		var header = this._parsed.header;
		
		this._el
		
		var keys = Object.keys(header);
		for (var i = 0; i < keys.length; i++) {
			this._elOutput.appendText('\n' + keys[i] + ': ' + header[keys[i]]);
		}
	},
	
	printOrders: function() {
		this._elOutput.appendText('\n\nORDERS');
		this._elOutput.appendText('\n--------------------------------------------------------------');
		this._elOutput.appendText('\n' + JSON.stringify(this._parsed.orders, undefined, '  '));
	},
	
	printInstruments: function() {
		this._elOutput.appendText('\n\nINSTRUMENTS');
		this._elOutput.appendText('\n--------------------------------------------------------------');
		this._elOutput.appendText('\n' + JSON.stringify(this._parsed.instruments, undefined, '  '));
	},
	
	printPatterns: function() {
		this._elOutput.appendText('\n\nPATTERNS');
		this._elOutput.appendText('\n--------------------------------------------------------------');
		this._elOutput.appendText('\n' + JSON.stringify(this._parsed.patterns, undefined, '  '));
	}
});