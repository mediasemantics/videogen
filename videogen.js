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

const URL_ANIMATE = "http://mediasemantics.com/animate";

class VideoGen {

    constructor(params) {
        this.params = params;
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
    }

    render() {
        this.callPolly((err)=> {
            if (err) console.log(err);
            this.callAnimate((err) => {
                if (err) console.log(err);
                this.loadSecondaryTextures(0, (err) => {
                    if (err) console.log(err);
                    this.padOrTruncateAudio((err) => {
                        if (err) console.log(err);
                        this.renderCore((err)=> {
                            this.removeTempFiles(() => {
                                console.log("Render complete.")
                            });
                        });
                    });
                });
            });
        });
    }

    // Creates an mp3 audio file. Sets this.audioFile and this.lipsync.
    callPolly(callback) {
        // Construct data for polly from the voice and text
        // Strip all xml tags for the version of the text going to Polly
        let textOnly = this.params.text.replace(new RegExp("<[^>]*>", "g"), "").replace("  "," ").trim(); 
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
        o.version = this.params.characterVersion,
        o.format = "png";
        o.width = this.params.width;
        o.height = this.params.height;
        o.charscale = 1;
        o.charx = 0;
        o.chary = 0;
        o.fps = "24";
        o.key = CHARACTER_API_KEY;
        o.backcolor = "#ffffff";
        o.with = "all";
        o.return = true; // but no recover
        o.zipdata = true;
        o.lipsync = this.lipsync;
        o.action = "<say>" + this.params.text + "</say>";
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
        o.version = this.params.characterVersion,
        o.format = "png";
        o.width = this.params.width;
        o.height = this.params.height;
        o.charscale = 1;
        o.charx = 0;
        o.chary = 0;
        o.fps = "24";
        o.key = CHARACTER_API_KEY;
        o.backcolor = "#ffffff";
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

        // Extract the pieces from the texture(s) - this is essentially a cache because the same pieces are likely to be reused
        // from frame to frame.
        this.extract(recipe, 0, (err) => {
            if (err) return callback(err);

            // Quick-create blank punchout images as necessary, to clear underlying image portions in raster characters
            this.createPunchouts(recipe, 0, (err) => {
                if (err) return callback(err);

                // Create the character image in a buffer
                let a = [];
                for (let i = 0; i < recipe.length; i++) {
                    if (!this.animData.layered) {
                        let punchoutKey = this.punchoutKeyFromRecipeItem(recipe, i);
                        a.push({input:this.punchoutDatas[punchoutKey], raw:this.punchoutInfos[punchoutKey], left:recipe[i][0], top:recipe[i][1]});  // unfortunately there is no source blend that is equivalent
                    }
                    let extractKey = this.extractKeyFromRecipeItem(recipe, i);
                    a.push({input:this.pieceDatas[extractKey], raw:this.pieceInfos[extractKey], left:recipe[i][0], top:recipe[i][1]});
                    // If you are generating other imagery in your video, it could come in here.
                }
                sharp({create: { width: this.params.width, height: this.params.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }}).composite(a).png({compressionLevel:0}).toBuffer((err, data) => {
                    if (err) return callback(err);

                    // Write the image off to ffmpeg
                    if (this.child && this.child.exitCode === null) this.child.stdin.write(data);
                    // fs.writeFileSync("frame"+frame+".png", data); // useful for debugging
                    data = null; 
                    return callback(null);
                });
            });
        });
    }

    extractKeyFromRecipeItem(recipe, i) {
        return recipe[i][2] + "-" + recipe[i][3] + "-" + recipe[i][4] + "-" + recipe[i][5] + "-" + recipe[i][6];
    }

    extract(recipe, i, callback) {
        if (i == recipe.length) return callback(null);

        let key = this.extractKeyFromRecipeItem(recipe, i);
        if (this.pieceDatas[key]) return this.extract(recipe, i+1, callback);
        
        let data = this.mainTexture;
        let info = this.mainTextureInfo;
        if (recipe[i][6] !== undefined) { // this is the secondary texture index - could be 0 though
            data = this.secondaryTextures[recipe[i][6]].data;
            info = this.secondaryTextures[recipe[i][6]].info;
        }

        sharp(data, {raw:info}).extract({ left:recipe[i][2], top:recipe[i][3], width:recipe[i][4], height:recipe[i][5] }).raw().toBuffer((err, data, info) => {
            if (err) return callback(err);
            this.pieceDatas[key] = data;
            this.pieceInfos[key] = info;
            console.log(".");
            return this.extract(recipe, i+1, callback);
        });
    }

    punchoutKeyFromRecipeItem(recipe, i) {
        return recipe[i][4] + "-" + recipe[i][5];
    }

    createPunchouts(recipe, i, callback) {
        if (this.animData.layered) return callback(null); // punchouts not needed
        if (i == recipe.length) return callback(null);
        
        let key = this.punchoutKeyFromRecipeItem(recipe, i);
        if (this.punchoutDatas[key]) return this.createPunchouts(recipe, i+1, callback);
        
        sharp({create: { width:recipe[i][4], height:recipe[i][5], channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }}).raw().toBuffer((err, data, info) => {
            if (err) return callback(err);
            this.punchoutDatas[key] = data;
            this.punchoutInfos[key] = info;
            this.createPunchouts(recipe, i+1, callback);
        });
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
}

// Startup as a command-line tool
if (POLLY_ACCESS_KEY.includes('XXX') || POLLY_SECRET_KEY.includes('XXX'))
    console.log('please edit videogen.js to provide valid AWS Polly credentials')
else if (CHARACTER_API_KEY.includes('XXX'))
    console.log('please edit videogen.js to provide valid Character API credentials (https://aws.amazon.com/marketplace/pp/B06ZY1VBFZ)')
else if (process.argv.length != 9)
    console.log('syntax: node videogen character version width height voice "text" outputfile\n e.g. node videogen SusanHead 3.0 250 200 NeuralJoanna "<headnod/> Hello world!" hello.mp4');
else if (process.argv[8].substr(-4) != ".mp4")
    console.log("output file must end in .mp4");
else
    new VideoGen({
        character: process.argv[2], 
        characterVersion: process.argv[3], 
        width: parseInt(process.argv[4]),
        height: parseInt(process.argv[5]),
        voice: process.argv[6], 
        text: process.argv[7], 
        outputFile: process.argv[8]}
    ).render();

