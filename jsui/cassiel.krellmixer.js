/*	-*- tab-width: 4; -*- */

/*	Krell Mixer UI, ca. 2008.

    A graphical display of a mixing matrix. Every matrix position has a control for
	setting gain/attenuation, with post-fade audio monitoring (all calculated/rendered
	in dB). The matrix takes lists of floats as input (audio levels, probably from
	peakamp~) and outputs commands for a matrix~ object.

	The display as a whole is the central matrix, plus the input (top) and output (right)
	strips with instrument names/legends.

	We use the OpenGL coordinate system throughout (mostly: we create sub-sketches
	from time to time), and all our coordinates are
	relative to the -1.0..1.0 height of the JSUI instance; we ignore the width
	completely.

	TODO:
		- Swatch input methods for Stevie.
        - Remove the scribble-strip machinery - we have textbrick for that now.
 */

autowatch = 0;

//	Colour object creation:

function COLOUR(r, g, b) {
	this.r = r;
	this.g = g;
	this.b = b;
}

/*	OBJECT DEFINITION for each cell of the array. */

function KRELL_CELL(xn, yn) {
	this.xn = xn;
	this.yn = yn;
	this.setting = 0;
	this.sprites00 = null;				//	No sprites for a setting of 0.
	this.lastInLevel = 0;				//	Last input level prior to mixing.
		//	TODO: since lastInLevel is prefade, we should just hold one value
	//	per column (not one per cell).
    this.db00 = null;
	this.multiplier = 0;				//	Attenuation multiplication value.
	this.colourIndex = 0;
}

//	Manifest constants.

var MYGLOBAL = "cassiel.krellmixer.GLOBAL";

var FONTSIZE = 24;
var FONTNAME = "Georgia";

var CELL_SIZE = 0.7;		//	Assumed within a sub-sketch.

var DOT_SIZE = 0.1;			//	Central dot.

//	Knob properties (audio settings).

var KNOB_UNITY = 0.75;
var KNOB_MAX_DB = 6;
var KNOB_MIN_DB = -40;		//	We'll crop to zero before we get there.
var KNOB_OFF_REGION = 0.01;

//	Divide ins from outs in arguments

// TODO: are these (legends) still used?

var NAME_DIVIDER = "//";

var NAME_IN = "IN";
var NAME_OUT = "OUT";

var SINGLE_IN = [NAME_IN];
var SINGLE_OUT = [NAME_OUT];

//	Colours.

var CELL_OFF = new COLOUR(0.6, 0.6, 0.6);
var PANEL_BG = new COLOUR(0.3, 0.3, 0.3);		//	Background colour
var DOT_COLOUR = new COLOUR(1, 1, 1);			//	Central dot
var TEXT_COLOUR = new COLOUR(0, 0, 0);			//	dB text
var HIGHLIGHT_COLOUR = new COLOUR(1, 1, 1);		//	Highlight ring
var NEEDLE_COLOUR = new COLOUR(0, 0, 0);		//	Needle

var NUM_LEVELS = 4;

/**	An array of regions of dB levels (actually, audio levels) for determining
	colour index. We do a linear interpolation here, which is not very efficient
	but hopefully not too much of an overhead for a small number of colours. */

var LEVEL_COLOURS = [
	{low: 0, colour: CELL_OFF},
	{low: db2ampl(-40), colour: new COLOUR(0.1, 0.9, 0.0)},
	{low: db2ampl(-12), colour: new COLOUR(0.9, 0.8, 0.2)},
	{low: db2ampl(0), colour: new COLOUR(1.0, 0.0, 0.0)}
];

//	A format tag for pattr.

var PATTR_TAG = "Mix.PATTR.2";

/*	Globals. */

var g_CellsAcross;
var g_CellsDown;
var g_CellPitch;

/*	2D array (xn, yn) of cells. */

var g_TheCells;

var g_Tint = new COLOUR(0, 0, 0);

/*	Simple tests for click/drag: */

var g_LastY = 0;

/*	Sprite size (X and Y) in pixels; generated by dimensions(). */

var g_SpriteSizePixels;

/*	Selected cell (within drag), or null. */

var g_SelectedCell00 = null;

/*	Scribble strips: */

var g_ScribbleIn, g_ScribbleOut;

/*	The "everything off" sprite. */

var g_OffSprite;

init();

/*	D R A W I N G */

/*	Let's have some tinting code available. We set an overall tint colour, and then
	for the actual drawing, we specify a mix amount between 0.0 as PANEL_BG and 1.0 as
	tint (cf. previous implementations which shifted to white). */

tint.local = true;
function tint(colour) {
	g_Tint = colour;
	//showProps("g_Tint", g_Tint);
}

setColour.local = true;
function setColour(sk, amount, alpha) {
	sk.glcolor(PANEL_BG.r * (1 - amount) + g_Tint.r * amount,
			   PANEL_BG.g * (1 - amount) + g_Tint.g * amount,
			   PANEL_BG.b * (1 - amount) + g_Tint.b * amount,
			   alpha
			  );
}

genSpriteSketch.local = true;
function genSpriteSketch() {
	var sk = new Sketch(g_SpriteSizePixels, g_SpriteSizePixels);

	with (sk) {
		font(FONTNAME);
		fontsize(FONTSIZE);
		textalign("center", "center");
	}

	return sk;
}

/**	Generate an array of sprites, across the colours, for a particular setting. */

genSprites.local = true;
function genSprites(setting, db00) {
	var a = new Array(NUM_LEVELS);

	for (var i = 0; i < NUM_LEVELS; i++) {
		var sk = genSpriteSketch();
		//	Y in both cases: all our scalings are relative to vertical pitch.

		drawCell(sk, LEVEL_COLOURS[i].colour, setting, db00);
		a[i] = sk;
	}

	return a;
}

/**	Generate (once only) the everything-off sprite. */

genOffSprite.local = true;
function genOffSprite() {
	var sk = genSpriteSketch();
	drawCell(sk, CELL_OFF, 0, null);
	return sk;
}

freeSprites.local = true;
function freeSprites(a) {
	for (var i = 0; i < a.length; i++) {
		a[i].freepeer();
	}
}

defaultScribble.local = true;
function defaultScribble(len, prefix) {
	var a = new Array(len);

	for (var i = 0; i < len; i++) {
		a[i] = prefix + "/" + (i + 1);
	}

	return a;
}

function init() {
	with (sketch) {
		fsaa = 1;
		glclearcolor(PANEL_BG.r, PANEL_BG.g, PANEL_BG.b, 1);
		glclear();
	}

	/*	We really want the "new form" of arguments: all the input names,
		then a "//", then all the output names. But we'll allow the old
		syntax (x, y) as well. */

	if (jsarguments.length == 3) {
		dimensions(defaultScribble(jsarguments[1], NAME_IN),
				   defaultScribble(jsarguments[2], NAME_OUT)
				  );
	} else if (jsarguments.length > 3) {		//	Ins, "//", outs
		var pos = 1;							//	Skip the filename
		var found = false;

		for (var i = pos; i < jsarguments.length; i++) {
			if (jsarguments[i] == NAME_DIVIDER) {
				found = true;
				var ins = jsarguments.slice(pos, i);
				var outs = jsarguments.slice(i + 1);
				//	TODO: ins or outs could have length zero.
				dimensions(ins, outs);
				break;
			}
		}

		if (!found) {
			dimensions(jsarguments.slice(pos), [NAME_OUT]);
				//	Rather arbitrary action if no divider: N-in, 1-out mixer.
		}
	} else {
		dimensions([NAME_IN], [NAME_OUT]);
	}

	announce();
}

announce.local = true;
function announce() {
	var g = new Global(MYGLOBAL);

	if (g.announced === undefined) {
		post("| cassiel.krellmixer");
		post("| nick rothwell, nick@cassiel.com / http://cassiel.com");
		g.announced = true;
	}
}

/**	Set the dimensions (given a vector of input names and a vector of output names). */

dimensions.local = true;
function dimensions(ins, outs) {
	g_CellsAcross = ins.length;
	g_CellsDown = outs.length;
	g_CellPitch = 2.0 / g_CellsDown;
	g_SpriteSizePixels = pixelCoords(0, 1.0 - g_CellPitch).y;		//	Square...

	g_TheCells = new Array(g_CellsAcross);

	sketch.glclear();		//	If dimensions change we might have dead areas...

	for (var i = 0; i < g_CellsAcross; i++) {
		g_TheCells[i] = new Array(g_CellsDown);

		for (var j = 0; j < g_CellsDown; j++) {
			var c = new KRELL_CELL(i, j);
			g_TheCells[i][j] = c;
			drawLive(c, false);
		}
	}

	//	Create the scribble strips. NOTE: ins and outs must be persistent!

	g_ScribbleIn = ins;
	g_ScribbleOut = outs;

	//	Now we have the dimensions:
	g_OffSprite = genOffSprite();

	refresh();
	notifyclients();

}

//	We can replace the ins and/or the outs, although a change which
//	alters a dimension requires a complete rebuild.

function inputnames() {
	var a = arrayfromargs(arguments);

	if (a.length == g_CellsAcross) {		//	Change names in place.
		g_ScribbleIn = a;
		refresh();
		notifyclients();
	} else {
		dimensions(a, g_ScribbleOut);		//	Regenerate.
	}
}

function outputnames() {
	var a = arrayfromargs(arguments);

	if (a.length == g_CellsDown) {
		g_ScribbleOut = a;
		refresh();
		notifyclients();
	} else {
		dimensions(g_ScribbleIn, a);
	}
}

//	General graphic: fill a disc with some colour and alpha.

fill.local = true;
function fill(sk, x, y, radius) {
	sk.moveto(x, y);

	setColour(sk, 0.8, 0.6);	//	Darker, some alpha.
	sk.circle(radius);
}

/*	Calculate the coordinates of a cell, where xn is counted across from zero, and
	yn is counted *down* from zero; we get the top left because we're about to
	bonk a sprite over it. Returns a pair. */

getTopLeft.local = true;
function getTopLeft(xn, yn) {
	var xPos = (-g_CellsAcross + (xn * 2)) * g_CellPitch / 2;

	//	yn is counted from top row, so invert sign of entire result.
	var yPos = -(-g_CellsDown + (yn * 2)) * g_CellPitch / 2;

	//post("cell (" + xn + ", " + yn + ") is at (" + xPos + ", " + yPos + ")\n");

	return {x: xPos, y: yPos};
}

/*	Find the cell (xn, yn) under a given position in OpenGL coordinates.
	we locate it according to its sprite/sketch, and should return null
	if we're actually outside the disc, but we aren't doing that yet. */

function locateCellAt00(x, y) {
	var left = -g_CellsAcross * g_CellPitch / 2;
	var top = g_CellsDown * g_CellPitch / 2;

	var xn = Math.floor((x - left) / g_CellPitch);
	var yn = Math.floor((top - y) / g_CellPitch);

	if (   xn < 0
	    || xn >= g_CellsAcross
	    || yn < 0
	    || yn >= g_CellsDown
	    ) {
		return null;
	} else {
		return g_TheCells[xn][yn];
	}
}

//	Clear a cell at OpenGL position (x, y) on a sub-sketch.

clearCell.local = true;
function clearCell(sk) {
	sk.glclearcolor(PANEL_BG.r, PANEL_BG.g, PANEL_BG.b, 1);
	sk.glclear();
}

/**	Angle of knob, given a setting. */

knobAngle.local = true;
function knobAngle(setting) {
	//	Coordinate system seems to be: 0 is X +ve, growing anticlockwise (to top).
	return -90 - 360 * setting;
}

/*	Draw slice (in the current tint): */

slice.local = true;
function slice(sk, proportion) {
	sk.moveto(0, 0);

	//setColour(sk, 1, 1);
	//sk.framecircle(CELL_SIZE);
	setColour(sk, 1, 0.8);
	//	Coordinate system seems to be: 0 is X +ve, growing anticlockwise (to top).
	//sk.circle(CELL_SIZE, base - 180 * proportion, base + 180 * proportion);
	sk.circle(CELL_SIZE, knobAngle(0), knobAngle(proportion));

	setColour(sk, 0.0, 0.0);	//	Lighter, some alpha.
	sk.circle(CELL_SIZE);
}

dot.local = true;
function dot(sk, x, y, alpha) {
	setColour(sk, 1, alpha);

	sk.moveto(x, y);
	sk.circle(DOT_SIZE);
}

ring.local = true;
function ring(sk, x, y) {
	setColour(sk, 1, 1);

	sk.moveto(x, y);
	sk.framecircle(CELL_SIZE);
}

needle.local = 0;
function needle(sk, proportion) {
	var radians = knobAngle(proportion) * Math.PI / 180;
	//sk.moveto(0, 0);
	//sk.line(CELL_SIZE * Math.cos(radians), CELL_SIZE * Math.sin(radians));
	dot(sk, (CELL_SIZE - DOT_SIZE) * Math.cos(radians),
		    (CELL_SIZE - DOT_SIZE) * Math.sin(radians),
		0.3
	   );
}

legend.local = true;
function legend(sk, text, x, y) {
	setColour(sk, 1, 1);
	sk.moveto(x, y);
	sk.text(text);
}

/*	Clear and draw a cell at OpenGL position (x, y). */

drawCell.local = true;
function drawCell(sk, colour, proportion, numeric00) {
    // post("drawCell(" + numeric00 + ")\n");
	clearCell(sk);

	tint(colour);
	slice(sk, proportion);

	tint(NEEDLE_COLOUR);
	needle(sk, proportion);

    // Testing... although I like more permanence to the digits:
	if (numeric00 != null) {
		//tint(HIGHLIGHT_COLOUR);
		//ring(sk, 0, 0);

		tint(TEXT_COLOUR);
        str = Math.round(numeric00);
        if (str > 0) { str = "+" + str; }
		legend(sk, String(str), 0, 0);
	} else {
		tint(DOT_COLOUR);
		dot(sk, 0, 0, 1);
	}
}

/**	Recalculate and update the colour index for a cell, given that its setting has changed.
	Returns true if the index has changed, false otherwise. */

function recalculateColourIndex(cell) {
	var oldIndex = cell.colourIndex;
	var postFadeLevel = cell.lastInLevel * cell.multiplier;

	for (var i = NUM_LEVELS - 1; i >= 0; i--) {
		if (postFadeLevel >= LEVEL_COLOURS[i].low) {
			cell.colourIndex = i;

			return (i != oldIndex);
		}
	}

	//	Shouldn't get here (unless we get levels < 0).

	return false;
}

/*	Input of list of (RMS) levels. We ignore extraneous values
	and assume zero for missing values (although we should probably complain). */

function list() {
	var a = arguments;
	var preFadeLevel;

	for (var xn = 0; xn < g_CellsAcross; xn++) {
		if (xn >= arguments.length) {			//	Pad with zeroes.
			preFadeLevel = 0;
		} else {
			preFadeLevel = arguments[xn];
		}

		for (var yn = 0; yn < g_CellsDown; yn++) {
			var c = g_TheCells[xn][yn];
			c.lastInLevel = preFadeLevel;

			var changed = recalculateColourIndex(c);

			if (changed) {
				if (c == g_SelectedCell00) {
					drawLive(c, true);
				} else {
					refreshCell(c, c.colourIndex);
				}
			}
		}
	}

	refresh();
}

pixelCoords.local = true;
function pixelCoords(x, y) {
	var a = sketch.worldtoscreen(x, y);
	return {x: a[0], y: a[1]};
}

/**	Draw a cell live - don't use any sprites. */

drawLive.local = true;
function drawLive(cell, highlight) {
	var sk = genSpriteSketch();
	//	Y in both cases: all our scalings are relative to vertical pitch.

	var db = dbText(setting2db00(cell.setting));
	drawCell(sk, LEVEL_COLOURS[cell.colourIndex].colour, cell.setting, db);

	var pos = getTopLeft(cell.xn, cell.yn);
	var spritePos = pixelCoords(pos.x, pos.y);
	sketch.copypixels(sk, spritePos.x, spritePos.y);
	sk.freepeer();
}

/*	A refresh call for a single cell, containing both the fader size and
	the colour cast index. */

refreshCell.local = true;
function refreshCell(cell, colourIndex) {
	var pos = getTopLeft(cell.xn, cell.yn);
	var spritePos = pixelCoords(pos.x, pos.y);

	cell.colourIndex = colourIndex;

	if (cell.sprites00 == null) {
		sketch.copypixels(g_OffSprite, spritePos.x, spritePos.y);
	} else {
		sketch.copypixels(cell.sprites00[colourIndex], spritePos.x, spritePos.y);
	}
}

/*	I N T E R A C T I O N */

/*	We map knob position to dB, and dB to amplitude multiplier. */

function db2ampl(db) {
	// 2.0 ^^ (db / 6.0)
	return Math.exp((db / 6) * Math.log(2));
}

function setting2db00(setting) {
	//	3 o'clock is nominal unity. We can boost to XXXdB or attenuate to -inf.
	//	(The attenuation scaling is linear: we head for -YYYdB but with a dead
	//	patch at the bottom.) "Off" (-inf dB) is signified by null.
	//	See the manifest constants for the actual numbers.

	if (setting > KNOB_UNITY) {
		return KNOB_MAX_DB * (setting - KNOB_UNITY) / (1 - KNOB_UNITY);
	} else if (setting <= KNOB_OFF_REGION) {
		return null;
	} else {
		return KNOB_MIN_DB * (KNOB_UNITY - setting) / KNOB_UNITY;
	}
}

/**	We stick to integral dB's for the on-screen display! */

function dbText(db00) {
	if (db00 == null) {
		return null;
	} else {
		var i = Math.round(db00);

		if (i > 0) {
			return "+" + i;
		} else {
			return String(i);
		}
	}
}

/*	Clicking/dragging. The initial onclick() is always a selector;
	if a cell is selected we remember it and update it during the drag. */

onclick.local = true;
function onclick(x, y) {
	// cache mouse position for tracking delta movements
	g_LastY = y;

	var a = sketch.screentoworld(x, y);
	var target00 = locateCellAt00(a[0], a[1]);

	if (target00 != null) {
		g_SelectedCell00 = target00;
		drawLive(g_SelectedCell00, true);
		refresh();
		//showProps("target", target00);
	}
}

setCellAndMatrix.local = true;
function setCellAndMatrix(cell, f) {
	f = Math.max(0, Math.min(f, 1));
	cell.setting = f;

	var db00 = setting2db00(f);
    cell.db00 = db00;

	if (db00 == null) {
		cell.multiplier = 0;
	} else {
		cell.multiplier = db2ampl(db00);
	}

	outlet(0, cell.xn, cell.yn, cell.multiplier);
}

/*	Rebuild the sprites for a cell whose setting has changed. If the cell is
	(now) "off", don't generate any. */

rebuildSprites.local = true;
function rebuildSprites(cell) {
	if (cell.sprites00 != null) {
		freeSprites(cell.sprites00);
	}

	if (cell.setting > KNOB_OFF_REGION) {
		cell.sprites00 = genSprites(cell.setting, cell.db00);
	} else {
		cell.sprites00 = null;
	}
}

ondrag.local = true;
function ondrag(x, y, but, cmd, shift) {
	if (g_SelectedCell00 != null) {
		var f, dy;

		if (but) {
			max.hidecursor();
			var setting = g_SelectedCell00.setting;
			//post("Old setting: " + setting + "\n");

			//	Calculate delta movements. This is all hard-wired by pixel distances, which is
			//	a bit odd, but functional as a lazy hack.

			dy = y - g_LastY;

			if (shift) {
				//	Fine tune if shift key is down
				f = setting - dy*0.001;
			} else {
				f = setting - dy*0.01;
			}

			setCellAndMatrix(g_SelectedCell00, f);

			/*void*/ recalculateColourIndex(g_SelectedCell00);

			drawLive(g_SelectedCell00, true);
			g_LastY = y;
			notifyclients();
		} else {		//	Button release?
			rebuildSprites(g_SelectedCell00);
			drawLive(g_SelectedCell00, false);
			g_SelectedCell00 = null;
			max.showcursor();
		}

		refresh();
	}
}

/*	Save and restore values (via pattr). We want a solution where saved matrix
	settings survive reorderings of the columns, or changing of the matrix
	size, so we save the current matrix size and menus of the symbolic names
	being used for the rows and columns.

	Format: magic tag, then xn and yn, then (xn) tags, then (yn) tags,
	then values, sweeping across and then down. */

function getvalueof() {
	var a = [PATTR_TAG];

	a.push(g_CellsAcross);
	a.push(g_CellsDown);
	a = a.concat(g_ScribbleIn);
	a = a.concat(g_ScribbleOut);

	for (var y = 0; y < g_CellsDown; y++) {
		for (var x = 0; x < g_CellsAcross; x++) {
			var cell = g_TheCells[x][y];
			a.push(cell.setting);
		}
	}

	return a;
}

/*	Given a current scribble strip, and a name array from the saved state,
	return a mapping from our scribble index to the index in the saved
	state, or undefined if our scribble token isn't saved. */

genMapper.local = true;
function genMapper(scribble, saved) {
	var result = new Array(scribble.length);

	for (var i = 0; i < scribble.length; i++) {
		var token = scribble[i];

		for (var j = 0; j < saved.length; j++) {
			if (saved[j] == token) {
				result[i] = j;			//	Our i'th column was saved in
				break;					//	position j.
			}
		}
	}

	return result;
}

function setvalueof() {
	var a = arrayfromargs(arguments);

	if (a.length < 3) {
		post("*** setvalueof: truncated?\n");
	} else if (a[0] != PATTR_TAG) {
		post("*** setvalueof: bad tag: " + a[0] + "\n");
	} else {		//	We take the format of the rest of the data on trust...
		var in_X = a[1];
		var in_Y = a[2];
		var pos = 3;
		var inNames = a.slice(pos, pos + in_X);
		//post("inNames: " + inNames.join(" ") + "\n");

		pos += in_X;

		var outNames = a.slice(pos, pos + in_Y);
		//post("outNames: " + outNames.join(" ") + "\n");

		pos += in_Y;

		//	Create arrays mapping our actual scribble indices to saved
		//	indices (with undefined for any of our actual tags aren't
		//	in the saved state).

		var mapperAcross = genMapper(g_ScribbleIn, inNames);
		var mapperDown = genMapper(g_ScribbleOut, outNames);

		for (var y = 0; y < g_CellsDown; y++) {
			for (var x = 0; x < g_CellsAcross; x++) {
				var cell = g_TheCells[x][y];
				var value00;

				if (mapperDown[y] === undefined || mapperAcross[x] === undefined) {
					//post("Can't restore x=", x, "y=", y, "\n");
					//	We can't restore this cell: the saved state doesn't know
					//	our Y name or our X name.
					value00 = 0;
				} else {
					var savedPos = pos + mapperDown[y] * in_X + mapperAcross[x];
					//post("CAN restore x=", x, "y=", y, "at", savedPos, "as", a[savedPos], "\n");
					value00 = a[savedPos];
				}

				setCellAndMatrix(cell, value00);
				rebuildSprites(cell);
				refreshCell(cell, cell.colourIndex);
			}
		}

		refresh();
	}
}

showProps.local = true;
function showProps(name, obj) {
	post(name + ":\n");
	showProps1(0, name, obj);
}

showProps1.local = true;
function showProps1(indent, id, obj) {
	for (var i in obj) {
		var subObj = obj[i];

		post("> ");

		for (var j = 0; j < indent; j++) {
			post("    ");
		}

		var subId = id + "." + i;

		post(subId + " = " + String(subObj) + "\n");

		showProps1(indent + 1, subId, subObj);
	}
}

function debugCells() {
	showProps("g_TheCells", g_TheCells);
	showProps("LEVEL_COLOURS", LEVEL_COLOURS);
}
