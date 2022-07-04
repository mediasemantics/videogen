const fs = require('fs');
var AWS = require('aws-sdk');
const request = require('request');
const { spawn } = require('child_process');
const sharp = require('sharp');
const zlib = require('zlib');
const mp3Duration = require('mp3-duration');

// TODO replace these with the appropriate credentials (see readme)
const POLLY_ACCESS_KEY = 'xxxxxxxxxxxxxx';
const POLLY_SECRET_KEY = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const CHARACTER_API_KEY = 'xxxxxxxx';

const URL_ANIMATE = "http://api.mediasemantics.com/animate";
const URL_CATALOG = "http://api.mediasemantics.com/catalog";

class VideoGen {

    constructor(params) {
        this.params = params;
        this.catalog = null;
        this.characterVersion = null;
        this.backgroundData = null;
        this.backgroundInfo = null;
        this.audioFile = null;
        this.lipsync = null;
        this.pngFile = null;
        this.animData = null;
        this.mainTexture = null;
        this.mainTextureInfo = null;
        this.secondaryTextures = [];
        this.child = null;
        this.err = null;
        this.pieceDatas = {};
        this.pieceInfos = {};
        this.punchoutDatas = {};
        this.punchoutInfos = {};
        this.lastRecipe = null;
        this.lastData = null;
        this.dataTransformed = null;
        this.infoTransformed = null;
    }

    render() {
        this.callCatalog((err)=> {
            if (err) return console.log(err.message);
            this.prepareBackground((err)=> {
                if (err) return console.log(err.message);
                    this.callPolly((err)=> {
                    if (err) return console.log(err.message);
                    this.callAnimate((err) => {
                        if (err) return console.log(err.message);
                        this.loadSecondaryTextures(0, (err) => {
                            if (err) return console.log(err.message);
                            this.padOrTruncateAudio((err) => {
                                if (err) return console.log(err.message);
                                this.renderCore((err)=> {
                                    this.removeTempFiles(() => {
                                        if (this.err) 
                                            console.log("Render failed - "+this.err.message)
                                        else    
                                            console.log("Render complete.")
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    }

    // Get the character catalog
    callCatalog(callback) {
        let o = {};
        o.key = CHARACTER_API_KEY;        
        request.get({url:URL_CATALOG, qs: o, encoding: null}, (err, httpResponse, body) => {
            if (err) return callback(err);
            if (httpResponse.statusCode >= 400) return callback(new Error(body.toString()));
            this.catalog = JSON.parse(body);
            // Check params
            let obj = this.catalog.characters.find(rec => rec.id == this.params.character);
            if (!obj) {
                let a = this.catalog.characters.map(rec => rec.id);
                return callback(new Error("character must be one of: " + a.join(" ")));
            }
            // Pick up the latest version
            this.characterVersion = obj.version;
            callback(null);
        });
    }

    prepareBackground(callback) {
        if (this.params.background.substr(0,1) == '#') {
            let solid = sharp({create: { width:this.params.width, height:this.params.height, channels: 4, background: this.params.background }});
            solid.raw().toBuffer((err, data, info) => {
                if (err) return callback(err);
                this.backgroundData = data;
                this.backgroundInfo = info;
                callback(null);
            });
        }        
        else {
            sharp(this.params.background).resize(this.params.width, this.params.height, {fit:"cover", position:"centre"}).raw().toBuffer((err, data, info) => {
                if (err) return callback(new Error("failed to load background "+err.message));
                this.backgroundData = data;
                this.backgroundInfo = info;
                callback(null);             
            });
        }
    }

    // Creates an mp3 audio file. Sets this.audioFile and this.lipsync.
    callPolly(callback) {
        // Construct data for polly from the voice and text
        // Strip all xml tags for the version of the text going to Polly
        let textOnly = this.params.say.replace(new RegExp("<[^>]*>", "g"), "").replace("  "," ").trim(); 
        // Use the Neural prefix to use the Neural version of an AWS voice
        let neural = false;
        let voice = this.params.voice;
        if (voice.substr(0,6) == "Neural") { // NeuralJoanna or Joanna
            neural = true;
            voice = voice.substr(6);
        }
        let pollyData = {
            OutputFormat: 'mp3',
            SampleRate: '24000',
            Text: textOnly,
            TextType: 'text',
            VoiceId: voice,
            Engine: (neural ? "neural" : "standard"),
        }
        // We'll create temp files in the same location as the output file
        this.audioFile = this.params.outputFile.replace(".mp4",".mp3");
        // Call polly
        let polly = new AWS.Polly({
            region: 'us-east-1', 
            maxRetries: 3, 
            accessKeyId: POLLY_ACCESS_KEY, 
            secretAccessKey: POLLY_SECRET_KEY, 
            timeout: 15000});     
        polly.synthesizeSpeech(pollyData, (err, data) => {
            if (err) return callback(err);
            fs.writeFile(this.audioFile, data.AudioStream, (err) => {
                if (err) return callback(err);
                pollyData.OutputFormat = 'json';
                pollyData.SpeechMarkTypes = ['viseme'];
                // Call it again for the phonemes
                polly.synthesizeSpeech(pollyData, (err, data) => {
                    if (err) return callback(err);
                    var zip = new require('node-zip')();
                    zip.file('lipsync', data.AudioStream);
                    // Compress it for the trip to animate
                    this.lipsync = zip.generate({base64:true,compression:'DEFLATE'});
                    callback(null);
                });
            });
        }); 
    }

    // Calls 'animate' to get the instructions and the main texture. Sets this.animData, this.mainTexture, this.mainTextureInfo
    callAnimate(callback) {
        let o = {};
        o.character = this.params.character;
        o.version = this.characterVersion,
        o.format = "png";
        o.width = this.params.width;
        o.height = this.params.height;
        o.charscale = 1;
        o.charx = this.params.offsetX;
        o.chary = this.params.offsetY;
        o.fps = "24";
        o.key = CHARACTER_API_KEY;
        o.with = "all";
        o.return = true; // but no recover
        o.zipdata = true;
        o.lipsync = this.lipsync;
        let template = this.getTemplateFromActionTag(this.params.do);
        let action = this.getXMLFromTemplate(template, this.remainingTagsToXML(this.params.say));
        o.action = action;
        // Call animate
        request.get({url:URL_ANIMATE, qs: o, encoding: null}, (err, httpResponse, body) => {
            if (err) return callback(err);
            if (httpResponse.statusCode >= 400) return callback(new Error(body.toString()));

            // Save away the main texture
            sharp(body).raw().toBuffer((err, data, info) => {
                if (err) return callback(err);
                this.mainTexture = data;
                this.mainTextureInfo = info;

                // Save away the animation data
                let buffer = Buffer.from(httpResponse.headers["x-msi-animationdata"], 'base64')
                zlib.unzip(buffer, (err, buffer) => {
                    if (err) return callback(new Error(err.message));
                    this.animData = JSON.parse(buffer);
                    callback(null);
                });
            });
        });
    }

    // We recommend calling 'animate' using "with=all" - the resulting texture is smaller and
    // faster to download, allowing for characters with higher resolutions and frame rates.
    // The tradeoff is that you have to then load the secondary textures. However these
    // are also very cachable, and should be kept around if you are generating several 
    // video segments and then concatenating them.
   
    // Calls 'animate' to get any secondary textures. Sets this.secondaryTextures
    loadSecondaryTextures(index, callback) {
        // This is a recursive function - here is the end condition:
        if (index == this.animData.textures.length) return callback(null);

        let texture = this.animData.textures[index];

        let o = {};
        o.character = this.params.character;
        o.version = this.characterVersion,
        o.format = "png";
        o.width = this.params.width;
        o.height = this.params.height;
        o.charscale = 1;
        o.charx = 0;
        o.chary = 0;
        o.fps = "24";
        o.key = CHARACTER_API_KEY;
        if (texture == "default") 
            o.action = "";
        else 
            o.texture = texture;
        request.get({url:URL_ANIMATE, qs: o, encoding: null}, (err, httpResponse, body) => {
            if (err) return callback(err);
            if (httpResponse.statusCode >= 400) return callback(new Error(body.toString()));
            sharp(body).raw().toBuffer((err, data, info) => {
                if (err) return callback(err);
                this.secondaryTextures.push({data, info});
                this.loadSecondaryTextures(index+1, callback);
            });
        });
    }

    // Now that we know the exact number of frames in the movie, we can either truncate the audio file or
    // create a second, blank, audio file (this.blankFile) to complete the movie.

    // May create this.blankFile if padding is required.
    padOrTruncateAudio(callback) {
        mp3Duration(this.audioFile, (err, duration) => {
            if (err) return callback(err);

            let durationMovie = this.animData.frames.length / 24;
            let gap = durationMovie - duration;

            // Case where we need to truncate the audio. This can happen if the audio ends in
            // silence, since the length of the movie is driven by the lipsync data.

            if (gap < 0) {
                let audioFileTemp = this.audioFile.replace(".mp3", "_temp.mp3");
                fs.rename(this.audioFile, audioFileTemp, ()=> {
                    let args = [
                        '-t', '00:00:'+durationMovie,
                        '-i', audioFileTemp,
                        this.audioFile
                    ];
                    this.child = spawn('ffmpeg', args);
                    this.child.stdout.on('data', (data) => {
                        //console.log(`child stdout:\n${data}`);  // for debugging
                    });
                    this.child.stderr.on('data', (data) => {
                        //console.error(`child stderr:\n${data}`);  // for debugging
                    });
                    this.child.on('close', (code)=>{
                        fs.unlink(audioFileTemp, () => {
                            callback(null);
                        });
                    });
                });
            }

            // Case where we need to pad the audio.
            else {
                this.blankFile = this.audioFile.replace(".mp3", "_blank.raw");
                // ffmpeg -f s16le -ar 24000 -ac 1 -i input.raw ...
                let cycles = Math.round(gap * 24000);
                // So need a file with cycles * 2 bytes of 0
                let buf = Buffer.alloc(cycles * 2);
                fs.writeFile(this.blankFile, buf, (err) => {
                    if (err) return callback(err);
                    callback(null);
                });
            }
        });
    }
    
    renderCore(callback) {
        // ffmpeg fails if the output file exists, so always delete it first
        fs.unlink(this.params.outputFile, () => {
            // See https://ffmpeg.org/documentation.html for parameter details
            let args = [
                    '-framerate', '24',
                    '-f', 'image2pipe',
                    '-i', '-',
            ];
            args = args.concat(['-i', this.audioFile]);
            if (this.blankFile) {
                args = args.concat([
                    '-f', 's16le',
                    '-ar', '24000',
                    '-ac', '1',
                    '-i', this.blankFile
                ]);
            }
            args = args.concat([
                '-vf', 'format=yuv420p'
            ]);	
            args = args.concat([this.params.outputFile]);
            this.child = spawn('ffmpeg', args);
            this.child.on('close', (code)=>{
                if (this.err) 
                    callback(this.err)
                else 
                    callback(null);
            });
            this.child.stdout.on('data', (data) => {
                //console.log(`child stdout:\n${data}`);
            });
            this.child.stderr.on('data', (data) => {
                //console.error(`child stderr:\n${data}`);
            });

            // Run doFrame() for all frames in the animData via recursion
            this.doFrame(0, (err)=>{
                if (err) this.err = err;
                if (this.child && this.child.exitCode === null) this.child.stdin.end();
            });
        });
    }

    doFrame(i, callback) {
        if (i == this.animData.frames.length) 
            return callback(null);
        //console.log("Rendering frame "+i);
        this.animate(i, (err)=>{
            if (err) return callback(err);
            this.doFrame(i+1, callback);
        });
    }

    animate(frame, callback) {
        // This is the recipe for this frame
        let recipe = this.animData.recipes[this.animData.frames[frame][0]];

        // Optimization - the recipe for the current frame is often identical to that of the last one
        if (this.lastRecipe && JSON.stringify(recipe) == JSON.stringify(this.lastRecipe)) { 
            // Write the last image off to ffmpeg again
            if (this.child && this.child.exitCode === null) this.child.stdin.write(this.lastData);
            return callback(null);
        }
        else {
            // Extract the pieces from the texture(s) - this is essentially a cache because the same pieces are likely to be reused
            // from frame to frame.
            this.extract(recipe, 0, (err) => {
                if (err) return callback(err);

                // Create any new punchouts - these are images that need transparent holes placed in them that match the 
                // rectangles where child parts will go - this is only needed because sharp does not have a composite mode
                // that supports overwriting, the way canvas does.
                this.punchout(recipe, 0, (err) => {
                    if (err) return callback(err);

                    // Used for HD characters - allows rotated mouth frames to be created as needed from a single image.
                    this.createTransformBuffer(recipe, (err) => {
                        if (err) return callback(err);
                        
                        // Create the character image in a buffer
                        let a = [];
                        for (let i = 0; i < recipe.length; i++) {
                            if (recipe[i][7] !== undefined) {
                                let extractKey = this.extractKeyFromRecipeItem(recipe, i);
                                let dataUntransformed = this.pieceDatas[extractKey];
                                let o = this.doTransform(recipe, i, dataUntransformed);
                                let process = recipe[i][7];
                                if (o) a.push({input:this.dataTransformed[process-1], raw:this.infoTransformed[process-1], left:recipe[i][0] + o.x, top:recipe[i][1] + o.y});
                            }                            
                            else if (!this.animData.layered) {
                                let punchoutKey = this.punchoutKeyFromRecipeItem(recipe, i);
                                if (punchoutKey) {
                                    a.push({input:this.punchoutDatas[punchoutKey], raw:this.punchoutInfos[punchoutKey], left:recipe[i][0], top:recipe[i][1]});
                                }
                                else {
                                    let extractKey = this.extractKeyFromRecipeItem(recipe, i);
                                    if (this.pieceDatas[extractKey])
                                        a.push({input:this.pieceDatas[extractKey], raw:this.pieceInfos[extractKey], left:recipe[i][0], top:recipe[i][1]});
                                }
                            }
                            else {
                                let extractKey = this.extractKeyFromRecipeItem(recipe, i);
                                if (this.pieceDatas[extractKey])
                                    a.push({input:this.pieceDatas[extractKey], raw:this.pieceInfos[extractKey], left:recipe[i][0], top:recipe[i][1]});
                            }
                        }
                        sharp({create: { width: this.params.width, height: this.params.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }}).composite(a).raw().toBuffer((err, data, info) => {
                            if (err) return callback(err);

                            // Actual 32 bit character image is now in data, info - here is where you can merge it with background art, another video, etc.
                            let a = [];
                            a.push({input:this.backgroundData, raw:this.backgroundInfo, left:0, top:0});
                            a.push({input:data, raw:info, left:this.params.offsetX, top:this.params.offsetY});
                            sharp({create: { width: this.params.width, height:this.params.height, channels: 3, background: { r: 255, g: 255, b: 255, } }}).composite(a).png({compressionLevel:0}).toBuffer((err, dataFinal) => {
                                if (err) return callback(err);
                                            
                                // Write the image off to ffmpeg
                                if (this.child && this.child.exitCode === null) this.child.stdin.write(dataFinal);

                                // fs.writeFileSync("frame"+frame+".png", data); // useful for debugging

                                // Remember the last frame in case the next one is identical
                                this.lastData = dataFinal;
                                this.lastRecipe = JSON.parse(JSON.stringify(recipe));
                            
                                data = null;
                                info = null;
                                dataFinal = null; 

                                return callback(null);
                            });
                        });
                    });
                });
            });
        }
    }

    extractKeyFromRecipeItem(recipe, i) {
        return recipe[i][2] + "-" + recipe[i][3] + "-" + recipe[i][4] + "-" + recipe[i][5] + "-" + recipe[i][6];
    }

    extract(recipe, i, callback) {
        if (i == recipe.length) return callback(null);

        recipe[i][4] = Math.min(this.params.width, recipe[i][4]);
        recipe[i][5] = Math.min(this.params.height, recipe[i][5]);

        let key = this.extractKeyFromRecipeItem(recipe, i);
        if (this.pieceDatas[key]) return this.extract(recipe, i+1, callback);
        
        let data = this.mainTexture;
        let info = this.mainTextureInfo;
        if (recipe[i][6] !== undefined) { // this is the secondary texture index - could be 0 though
            data = this.secondaryTextures[recipe[i][6]].data;
            info = this.secondaryTextures[recipe[i][6]].info;
        }

        // Special case where, do to cutoff, extract is a no-op
        if (recipe[i][4] == 0 || recipe[i][5] == 0) {
            this.pieceDatas[key] = null; // means we skip this, later on
            this.pieceInfos[key] = null;
            return this.extract(recipe, i+1, callback);
        }

        // Normal case        
        sharp(data, {raw:info}).extract({ left:recipe[i][2], top:recipe[i][3], width:recipe[i][4], height:recipe[i][5] }).raw().toBuffer((err, data, info) => {
            if (err) return callback(err);
            this.pieceDatas[key] = data;
            this.pieceInfos[key] = info;
            return this.extract(recipe, i+1, callback);
        });
    }

    punchoutKeyFromRecipeItem(recipe, i) {
        // Describes the ingredients that go into the punchout algorithm, so we can use a hash to reuse them. Returns a blank string if no actual punchout work is needed.
        let extractKey = this.extractKeyFromRecipeItem(recipe, i);
        let info = this.pieceInfos[extractKey];
        let s = '';
        for (let iAbove = i+1; iAbove < recipe.length; iAbove++) {
            // [target-x, target-y, source-x, source-y, width, height]
            let {xActual, yActual, wActual, hActual} = this.clip(info, recipe[iAbove][0] - recipe[i][0], recipe[iAbove][1] - recipe[i][1], recipe[iAbove][4], recipe[iAbove][5]);
            if (wActual > 0 && hActual > 0 && recipe[iAbove][7] === undefined)  // last check: transformed children, e.g. hd character mouths, are an exception - we do not punch for these
                s += xActual + " " + yActual + " " + wActual + " " + hActual;
        }
        return s ? extractKey + " punchout " + s : '';
    }    

    punchout(recipe, i, callback) {
        if (this.animData.layered) return callback(null); // punchouts not needed
        if (i == recipe.length) return callback(null);
        
        let punchoutKey = this.punchoutKeyFromRecipeItem(recipe, i);
        if (!punchoutKey || this.punchoutDatas[punchoutKey]) return this.punchout(recipe, i+1, callback);
        
        let extractKey = this.extractKeyFromRecipeItem(recipe, i);
        sharp(this.pieceDatas[extractKey], {raw:this.pieceInfos[extractKey]}).toBuffer((err, data, info) => {
            if (err) return callback(err);
            for (let iAbove = i+1; iAbove < recipe.length; iAbove++) {
                let {xActual, yActual, wActual, hActual} = this.clip(info, recipe[iAbove][0] - recipe[i][0], recipe[iAbove][1] - recipe[i][1], recipe[iAbove][4], recipe[iAbove][5]);
                if (wActual > 0 && hActual > 0 && recipe[iAbove][7] === undefined)
                    this.doPunchout(data, info, recipe[iAbove][0] - recipe[i][0], recipe[iAbove][1] - recipe[i][1], recipe[iAbove][4], recipe[iAbove][5]);
            }
            this.punchoutDatas[punchoutKey] = data;
            this.punchoutInfos[punchoutKey] = info;
            this.punchout(recipe, i+1, callback);
        });
    }

    doPunchout(data, info, x, y, w, h) {
        let {xActual, yActual, wActual, hActual} = this.clip(info, x, y, w, h);
        // Now use a fast fill
        let arr32 = new Uint32Array(data.buffer);
        for (let yRun = yActual; yRun < yActual + hActual; yRun++) {
            let start = (yRun * info.width) + xActual;
            let end = start + wActual;
            arr32.fill(0, start, end); // 0 is black transparent
        }
    }

   // Needed for HD characters only
   createTransformBuffer(recipe, callback) {
        if (this.animData.mouthBendRadius && !this.dataTransformed) {

            // Find the transformed layer to get the size (assumption is there is only one, always the same size)
            let width1 = 1, height1 = 1;
            let width2 = 1, height2 = 1;
            let width3 = 1, height3 = 1;
            for (let i = 0; i < recipe.length; i++) {
                if (recipe[i][7] !== undefined) {
                    if (recipe[i][7] == 1) {
                        width1 = recipe[i][4];
                        height1 = recipe[i][5];
                    }
                    else if (recipe[i][7] == 2) {
                        width2 = recipe[i][4];
                        height2 = recipe[i][5];
                    }
                    else if (recipe[i][7] == 3) {
                        width3 = recipe[i][4];
                        height3 = recipe[i][5];
                    }
                }
            }
            this.dataTransformed = [];
            this.infoTransformed = [];
            sharp({create: { width: width1, height: height1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }}).raw().toBuffer((err, data, info) => {    
                if (err) return callback(err);
                this.dataTransformed[0] = data;
                this.infoTransformed[0] = info;

                sharp({create: { width: width2, height: height2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }}).raw().toBuffer((err, data, info) => {    
                    if (err) return callback(err);
                    this.dataTransformed[1] = data;
                    this.infoTransformed[1] = info;
                    
                    sharp({create: { width: width3, height: height3, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }}).raw().toBuffer((err, data, info) => {    
                        if (err) return callback(err);
                        this.dataTransformed[2] = data;
                        this.infoTransformed[2] = info;
                    
                        callback(err);
                    });
                });
            });
        }
        else return callback();    
    }

    // This is fully sychronous - apply transform recipe[i] on data, rendering to this.dataTransformed, this.infoTransformed and returns {x,y} offset
    doTransform(recipe, i, data) {
        // Gather params
        var width = recipe[i][4];
        var height = recipe[i][5];
        var xSrcImage = recipe[i][0];
        var ySrcImage = recipe[i][1];
        var process = recipe[i][7];
        var rb = process == 1 ? this.animData.mouthBendRadius : (process == 2 || this.animData.jawBendRadius != undefined ? this.animData.jawBendRadius : 0);
        var rt = process == 1 ? this.animData.mouthTwistRadius : (process == 2 || this.animData.jawTwistRadius != undefined ? this.animData.jawTwistRadius : 0);
        var bend = - recipe[i][8] / 180 * Math.PI;
        var twist = recipe[i][9] / 180 * Math.PI;
        var side = recipe[i][10] / 180 * Math.PI;
        side += twist * this.animData.twistToSide;
        var sideLength = this.animData.sideLength;
        var lowerJawDisplacement = this.animData.lowerJawDisplacement;
        var lowerJaw = recipe[i][8];
        var shoulderDisplacement = this.animData.shoulderDisplacement;
        var shoulders = recipe[i][8];        
        var x = recipe[i][11];
        var y = recipe[i][12];
        // Bend/twist are a non-linear z-rotate - side and x,y are linear - prepare a matrix for the linear portion.
        // 0 2 4 
        // 1 3 5
        var m = [1, 0, 0, 1, 0, 0];
        if (side) {
            this.addXForm(1, 0, 0, 1, 0, -sideLength, m);
            this.addXForm(Math.cos(side), Math.sin(side), -Math.sin(side), Math.cos(side), 0, 0, m);
            this.addXForm(1, 0, 0, 1, 0, sideLength, m);
        }
        if (x || y) {
            this.addXForm(1, 0, 0, 1, x, y, m);
        }
        // Setup source, target
        let source = data;
        let target = this.dataTransformed[process-1];
        // Return the image displacement
        var deltax = 0;
        var deltay = 0;
        if (process == 1 || this.animData.jawBendRadius != undefined) {
            // Assume same size for destination image as for src, and compute where the origin will fall
            var xDstImage = Math.floor(xSrcImage + rt * Math.sin(twist));
            var yDstImage = Math.floor(ySrcImage - rb * Math.sin(bend));
            deltax = xDstImage - xSrcImage;
            deltay = yDstImage - ySrcImage;
            // Setup feathering
            var a = width / 2;
            var b = height / 2;
            var xp = width - 5; // 5 pixel feathering
            var vp = (xp-a)*(xp-a)/(a*a);
            // Main loop
            var xDstGlobal,yDstGlobal,xSrcGlobalZ,ySrcGlobalZ,xSrcGlobal,ySrcGlobal,xSrc,ySrc,x1Src,x2Src,y1Src,y2Src,offSrc1,offSrc2,offSrc3,offSrc4,rint,gint,bint,aint;
            var offDst = 0;
            for (var yDst = 0; yDst < height; yDst++) {
                for (var xDst = 0; xDst < width; xDst++) {
                    xDstGlobal = xDst + 0.001 - width/2 + deltax ;
                    yDstGlobal = yDst + 0.001 - height/2 + deltay;
                    // z-rotate on an elliptic sphere with radius rb, rt
                    xSrcGlobalZ = rt * Math.sin(Math.asin(xDstGlobal/rt) - twist);
                    ySrcGlobalZ = rb * Math.sin(Math.asin(yDstGlobal/rb) + bend);
                    xSrcGlobal = m[0] * xSrcGlobalZ + m[2] * ySrcGlobalZ + m[4];
                    ySrcGlobal = m[1] * xSrcGlobalZ + m[3] * ySrcGlobalZ + m[5];
                    xSrc = xSrcGlobal + width/2;
                    ySrc = ySrcGlobal + height/2;
                    // bilinear interpolation - https://en.wikipedia.org/wiki/Bilinear_interpolation
                    x1Src = Math.max(Math.min(Math.floor(xSrc), width-1), 0);
                    x2Src = Math.max(Math.min(Math.ceil(xSrc), width-1), 0);
                    y1Src = Math.max(Math.min(Math.floor(ySrc), height-1), 0);
                    y2Src = Math.max(Math.min(Math.ceil(ySrc), height-1), 0);
                    if (x1Src == x2Src) {
                        if (x1Src == 0) x2Src++; else x1Src--;
                    }
                    if (y1Src == y2Src) {
                        if (y1Src == 0) y2Src++; else y1Src--;
                    }
                    // ImageData pixel ordering is RGBA
                    offSrc1 = y1Src*4*width + x1Src*4;
                    offSrc2 = y1Src*4*width + x2Src*4;
                    offSrc3 = y2Src*4*width + x1Src*4;
                    offSrc4 = y2Src*4*width + x2Src*4;
                    rint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+0] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+0] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+0] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+0]);
                    gint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+1] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+1] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+1] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+1]);
                    bint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+2] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+2] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+2] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+2]);
                    var v = (xDst-a)*(xDst-a)/(a*a) + (yDst-b)*(yDst-b)/(b*b);
                    var alpha;
                    if (process == 1) {
                        if (v > 1) 
                            alpha = 0;
                        else if (v >= vp && v <= 1) 
                            alpha = Math.round(255 * (1 - ((v - vp)/(1 - vp))));
                        else 
                            alpha = 255;
                    }
                    else if (process == 2) {
                        alpha = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+3] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+3] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+3] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+3]);                
                        if (yDst < height/10)
                            alpha = Math.min(alpha, yDst /  (height/10) * 255);
                    }
                    else {
                        alpha = 255;
                    }
                    target[offDst] = rint; offDst++;
                    target[offDst] = gint; offDst++;
                    target[offDst] = bint; offDst++;
                    target[offDst] = alpha; offDst++;
                }
            }       
        } 
        else if (process == 2) {
            // Main loop
            var xSrc,ySrc,x1Src,x2Src,y1Src,y2Src,offSrc1,offSrc2,offSrc3,offSrc4,rint,gint,bint,aint;
            var offDst = 0;
            for (var yDst = 0; yDst < height; yDst++) {
                for (var xDst = 0; xDst < width; xDst++) {
                    xSrc = xDst;
                    ySrc = yDst - (lowerJaw * lowerJawDisplacement * yDst / height);
                    x1Src = Math.max(Math.min(Math.floor(xSrc), width-1), 0);
                    x2Src = Math.max(Math.min(Math.ceil(xSrc), width-1), 0);
                    y1Src = Math.max(Math.min(Math.floor(ySrc), height-1), 0);
                    y2Src = Math.max(Math.min(Math.ceil(ySrc), height-1), 0);
                    if (x1Src == x2Src) {
                        if (x1Src == 0) x2Src++; else x1Src--;
                    }
                    if (y1Src == y2Src) {
                        if (y1Src == 0) y2Src++; else y1Src--;
                    }
                    offSrc1 = y1Src*4*width + x1Src*4;
                    offSrc2 = y1Src*4*width + x2Src*4;
                    offSrc3 = y2Src*4*width + x1Src*4;
                    offSrc4 = y2Src*4*width + x2Src*4;
                    rint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+0] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+0] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+0] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+0]);
                    gint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+1] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+1] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+1] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+1]);
                    bint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+2] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+2] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+2] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+2]);
                    var alpha;
                    alpha = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+3] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+3] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+3] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+3]);                
                    if (yDst < height/10)
                        alpha = Math.min(alpha, yDst /  (height/10) * 255);
                    target[offDst] = rint; offDst++;
                    target[offDst] = gint; offDst++;
                    target[offDst] = bint; offDst++;
                    target[offDst] = alpha; offDst++;
                }
            }
        }
        else if (process == 3) {
            // Main loop
            var xSrc,ySrc,x1Src,x2Src,y1Src,y2Src,offSrc1,offSrc2,offSrc3,offSrc4,rint,gint,bint,aint;
            var offDst = 0;
            for (var yDst = 0; yDst < height; yDst++) {
                for (var xDst = 0; xDst < width; xDst++) {
                    xSrc = xDst;
                    ySrc = yDst - (shoulders * shoulderDisplacement * yDst / height);
                    x1Src = Math.max(Math.min(Math.floor(xSrc), width-1), 0);
                    x2Src = Math.max(Math.min(Math.ceil(xSrc), width-1), 0);
                    y1Src = Math.max(Math.min(Math.floor(ySrc), height-1), 0);
                    y2Src = Math.max(Math.min(Math.ceil(ySrc), height-1), 0);
                    if (x1Src == x2Src) {
                        if (x1Src == 0) x2Src++; else x1Src--;
                    }
                    if (y1Src == y2Src) {
                        if (y1Src == 0) y2Src++; else y1Src--;
                    }
                    offSrc1 = y1Src*4*width + x1Src*4;
                    offSrc2 = y1Src*4*width + x2Src*4;
                    offSrc3 = y2Src*4*width + x1Src*4;
                    offSrc4 = y2Src*4*width + x2Src*4;
                    rint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+0] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+0] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+0] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+0]);
                    gint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+1] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+1] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+1] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+1]);
                    bint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+2] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+2] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+2] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+2]);
                    var alpha;
                    alpha = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source[offSrc1+3] + (xSrc-x1Src)*(y2Src-ySrc) * source[offSrc2+3] + (x2Src-xSrc)*(ySrc-y1Src) * source[offSrc3+3] + (xSrc-x1Src)*(ySrc-y1Src) * source[offSrc4+3]);                
                    target[offDst] = rint; offDst++;
                    target[offDst] = gint; offDst++;
                    target[offDst] = bint; offDst++;
                    target[offDst] = alpha; offDst++;
                }
            }
        }        
        return {x:deltax, y:deltay};
    }

    addXForm(a, b, c, d, e, f, m) {
        // a c e   ma mc me
        // b d f . mb md mf  
        // 0 0 1   0  0  1 
        m[0] = a * m[0] + c * m[1];     m[2] = a * m[2] + c * m[3];     m[4] = a * m[4] + c * m[5] + e; 
        m[1] = b * m[0] + d * m[1];     m[3] = b * m[2] + d * m[3];     m[5] = b * m[4] + d * m[5] + f;
    }

    clip(info, x, y, w, h) {
        let xActual = x;
        let yActual = y;
        let wActual = w;
        let hActual = h;
        if (xActual < 0) { // overhangs to the left
            wActual = Math.max(0, wActual - -xActual);
            xActual = 0;
        }
        if (xActual + wActual > info.width) { // overhangs to the right - can overhang both...
            wActual = Math.max(0, wActual - (xActual + wActual - info.width));
        }
        if (yActual < 0) {
            hActual = Math.max(0, hActual - -yActual);
            yActual = 0;
        }
        if (yActual + hActual > info.height) {
            hActual = Math.max(0, hActual - (yActual + hActual - info.height));
        }
        return {xActual, yActual, wActual, hActual};
    }

    removeTempFiles(callback) {
        fs.unlink(this.audioFile, () => {
            if (this.blankFile) {
                fs.unlink(this.blankFile, () => {
                    callback();
                });
            }
            else {
                callback();
            }
        });
    }

    remainingTagsToXML(s) {
        // [headright] -> <headright/>
        s = s.replace(/\[([\w-]*?)\]/g, '<$1/>');
        // [pause 500ms] -> <pause msec="$1"/>
        s = s.replace(/\[pause (.*?)ms\]/g, '<pause msec="$1"/>');
        return s;
    }
    
    getTemplateFromActionTag(tag) {
        let charrec = this.catalog.characters.find(rec => rec.id == this.params.character);
        let style = charrec.style;
        for (let i = 0; i < this.catalog.actions.length; i++) {
            let actionrec = this.catalog.actions[i];
            if (actionrec.id == tag) {
                var categoryrec = this.catalog.actionCategories.find(rec => rec.id == actionrec.category);
                if (!categoryrec || !categoryrec.characterStyles || categoryrec.characterStyles.indexOf(style) != -1) {
                    return actionrec.xml;
                }
            }
        }
        return "";
    }

    getXMLFromTemplate(action, say) {
        let charrec = this.catalog.characters.find(rec => rec.id == this.params.character);
        let style = charrec.style;
        let hd = style.split("-")[0] == "hd";
        let bob = true;
        if (say) {
            // e.g. action: "<lookleft/><gestureleft/><cmd type='apogee'>+{max:5}+<lookuser/><handsbyside/>+{max:0,user:1}"
            var a = action ? action.split("+") : ["{max:0,user:1}"];  // latter is the default Look At User
            // e.g. a = ["{max:0,user:1}"]
            //      a = ["<lookleft/><gestureleft/><cmd type='apogee'>", "{max:5}", "<lookuser/><handsbyside/>", "{max:0,user:1}"]
            var b = say.split(" "); // e.g. ["this", "is", "a", "test"]
            var seeds = [1];
            for (var i = 0; i < say.length; i++)
                seeds[0] += 13 * say.charCodeAt(i);
            var j = 0; // index into b
            var wordsSinceBlink = 0;
            var s = "";
            for (var i = 0; i < a.length; i++) {
                if (a[i].substr(0,1) != '{') {
                    s += a[i]; // regular action commands
                }
                else {
                    var rec = JSON.parse(a[i].replace('max','"max"').replace('user','"user"').replace('silence','"silence"')); // quick parse
                    if (rec.silence) {
                        s += '[silence ' + rec.silence + 'ms]';
                        continue;
                    }
                    var c = rec.max;
                    // Case where there were no (or few) words - i.e. user used an audio file but neglected to give us a script, or an unusually short script - insert a pause
                    if (c > 0 && b.length <= 3)
                        s += "<pause/>";
                    if (hd) {
                        if (rec.user)
                            s += '<fill name="speak1"/> ';
                        // peel off up to max words (or all the words)
                        while (j < b.length && (c > 0 || rec.max == 0)) { // while there are words left and we have not exceeded our max, if any
                            s += b[j];  // add next word
                            if (j < b.length - 1) { // if this is not the last word, add a space
                                s += " ";
                            }
                            j++;
                            c--;
                        }
                    }
                    else {
                        // peel off up to max words (or all the words)
                        while (j < b.length && (c > 0 || rec.max == 0)) { // while there are words left and we have not exceeded our max, if any
                            s += b[j];  // add next word
                            if (j < b.length - 1) { // if this is not the last word, add a space OR a command 
                                if (!rec.user) 
                                    s += " "; // there can be no head-bob here, e.g. head turned - and might as well not blink either
                                else {
                                    if (bob && j < b.length - 5 && this.seededRandom(seeds) < 0.33) { // roughly 1/3 words get a bob, but not right towards the end
                                        s += this.randomHead(seeds);
                                    }
                                    else if (wordsSinceBlink > 10) {
                                        s += " <blink/> ";
                                        wordsSinceBlink = 0;
                                    }
                                    else s += " ";
                                }
                            }
                            wordsSinceBlink++;
                            j++;
                            c--;
                        }
                    }
                }
            }
            action = "<say>" + s + "</say>";
        }
        else {
            // Case where user has no script or audio tag - just an action - now we need to interpret our tags a bit differently
            var a = action ? action.split("+") : [];
            var s = "";
            for (var i = 0; i < a.length; i++) {
                if (a[i].substr(0,1) != '{') {
                    s += a[i]; // regular action commands
                }
                else {
                    var rec = JSON.parse(a[i].replace('max','"max"').replace('user','"user"').replace('silence','"silence"'));
                    if (rec.max) s += "<pause/>"; // this is what we had before our switch to +{}+ commands
                }
            }
            action = s;
        }
        return action;
    } 
    
    seededRandom(seeds) {
        var x = Math.sin(seeds[0]++) * 10000;
        return x - Math.floor(x);
    }

    randomHead(seeds) {
        var n = (1+Math.floor(this.seededRandom(seeds)*4));
        if (n == 3) return " <headuser/> "
        else return " <headrandom"+n+"/> ";
    }    
}

// Startup as a command-line tool
if (POLLY_ACCESS_KEY.indexOf('xxx') > -1 || POLLY_SECRET_KEY.indexOf('xxx') > -1)
    console.log('please edit videogen.js to provide AWS Polly credentials')
else if (CHARACTER_API_KEY.indexOf('xxx') > -1)
    console.log('please edit videogen.js to provide Character API credentials (https://aws.amazon.com/marketplace/pp/B06ZY1VBFZ)')
else if (process.argv.length != 12)
    console.log('syntax: node videogen character background width height offsetx offsety voice "do" "say" outputfile\nBackground can be a hex color value or an image file, and offset controls placement of character in background.\nFor "do" and "say", please see https://www.mediasemantics.com/characters.html\ne.g. node videogen MichelleHead SkyHigh250x200.jpg 250 200 0 0 NeuralJoanna "greet" "Hi there!" hello.mp4');
else if (process.argv[11].substr(-4) != ".mp4")
    console.log("output file must end in .mp4");
else if (process.argv[10].length > 255)
    console.log("Maximum say length is 255 characters - recommend rendering one sentence at a time and then concatenating.");
else
    new VideoGen({
        character: process.argv[2], 
        background: process.argv[3], 
        width: parseInt(process.argv[4]),
        height: parseInt(process.argv[5]),
        offsetX: parseInt(process.argv[6]),
        offsetY: parseInt(process.argv[7]),
        voice: process.argv[8], 
        do: process.argv[9], 
        say: process.argv[10], 
        outputFile: process.argv[11]}
    ).render();

