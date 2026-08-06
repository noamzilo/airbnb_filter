// Read/write Firefox's mozLz4 container (sessionstore.jsonlz4 and friends).
// Layout: magic "mozLz40\0" + uint32 LE decompressed size + one LZ4 block.
//
// Writing uses an all-literals block -- valid LZ4 (it is exactly what LZ4 emits for
// incompressible input) and about 20 lines instead of a compressor. The files are a
// few hundred KB at most, so the lost compression does not matter.

const fs = require("fs");

const MAGIC = Buffer.from("mozLz40\0", "latin1");

function decompress(src, outLen) {
	const out = Buffer.alloc(outLen);
	let i = 0;
	let o = 0;
	while (i < src.length) {
		const token = src[i++];
		let lit = token >> 4;
		if (lit === 15) {
			let b;
			do {
				b = src[i++];
				lit += b;
			} while (b === 255);
		}
		src.copy(out, o, i, i + lit);
		i += lit;
		o += lit;
		if (i >= src.length) break;
		const offset = src[i] | (src[i + 1] << 8);
		i += 2;
		let ml = token & 0xf;
		if (ml === 15) {
			let b;
			do {
				b = src[i++];
				ml += b;
			} while (b === 255);
		}
		ml += 4;
		let from = o - offset;
		for (let k = 0; k < ml; k++) out[o++] = out[from++]; // may overlap: byte-by-byte
	}
	return out.subarray(0, o);
}

function compressLiterals(buf) {
	const head = [];
	if (buf.length < 15) {
		head.push(buf.length << 4);
	} else {
		head.push(0xf0);
		let rest = buf.length - 15;
		while (rest >= 255) {
			head.push(255);
			rest -= 255;
		}
		head.push(rest);
	}
	return Buffer.concat([Buffer.from(head), buf]);
}

function read(file) {
	const raw = fs.readFileSync(file);
	if (!raw.subarray(0, 8).equals(MAGIC)) throw new Error(`${file}: not a mozLz4 file`);
	const size = raw.readUInt32LE(8);
	return decompress(raw.subarray(12), size).toString("utf8");
}

function write(file, text) {
	const body = Buffer.from(text, "utf8");
	const size = Buffer.alloc(4);
	size.writeUInt32LE(body.length);
	fs.writeFileSync(file, Buffer.concat([MAGIC, size, compressLiterals(body)]));
}

module.exports = { read, write };
