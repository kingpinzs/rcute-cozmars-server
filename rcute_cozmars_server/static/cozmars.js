function sleep(sec){return new Promise((r,j)=>{setTimeout(r, sec*1000)})}
class rj {
	constructor(r, j) {
		this._r = r;
		this._j = j;
		this._resolved = this._rejected = false;
	}
	get resolve(){
		if (!this.done) this._resolved=true;
		return this._r
	}
	get reject(){
		if(!this.done) this._rejected=true;
		return this._j
	}
	get resolved(){return this._resolved}
	get rejected(){return this._rejected}
	get done(){return this._resolved || this.rejected}
}
class Cozmars {
	constructor(ip_or_serial) {
		this.host = ip_or_serial+(ip_or_serial.length==4?'.local':'');
		for (var a of ['infrared', 'button', 'sonar'])
			this[a] = {}
		this.infrared.state = [1, 1];
		this.camera = new Camera(this);
		this.lift = new Lift(this);
		this.head = new Head(this);
		this.buzzer = new Buzzer(this);
		this.motor = new Motor(this);
		this.screen = new Screen(this);
		// this.eyes = new EyeAnimation(this);
	}
	stopAllMotors() {
		if (this.connected) {
			this.motor.speed([0,0]);
			this.head.angle(null);
			this.lift.height(null);
		}
	}
	async connect(){
		const ws = new WebSocket('ws://'+this.host+'/rpc');
		ws.onclose = (e)=>{console.debug('cozmars ws closed'); this.disconnect();} 
		ws.onerror = (e)=>{console.error('cozmars ws error:', e);}
		if('-1' == await new Promise((r,j)=>{ws.onmessage=e=>{r(e.data)}})) throw 'Please close other programs or pages that are connecting to Cozmars first';
		this.ws = ws;
		this._stub = new RPCClient(ws);
		this._startSensorTask();
		this._connected = true;
	}
	disconnect(){
		this._sensorTask && this._sensorTask.reject();
		this.eyes.expression('stop');
		this._senorRpc && this._senorRpc.cancel();			
		this.camera.close();
		this.ws.close();
		this._connected = false;
	}
	get connected() {
		return this._connected;
	}
	_startSensorTask() {
		return new Promise((r, j)=>{
			this._sensorTask = new rj(r, j);
			this._sensorRpc = this._stub.rpc('sensor_data', [3]);
			(async ()=>{
				for await(var [ev, data] of this._sensorRpc){
					try{
						switch(ev){
							case 'pressed':
							if (!data)
								this.button.held = this.button.doublePressed = false;
							this.button.pressed = data;
							this.button.released = !this.button.pressed
							break;
							case 'double_pressed': 
							this.button.pressed = this.button.doublePressed = data;
							this.button.released = !this.button.pressed
							break;
							case 'held':
							this.button.held = data;
							break;
							case 'sonar':
							this.sonar.distance = data;
							break;
							case 'lir':
							this.infrared.state = [data, this.infrared.state[1]];
							break;
							case 'rir':
							this.infrared.state = [this.infrared.state[0], data];
							break;
						}
					} catch (e) {
						console.error(e);
					}
				}
			})();
		});
	}
	async animate(name, ignored) {
		var a = animation_list[name];
		await (typeof(a)=='function'?a(this, ignored): a.animate(this, ignored));
	}
}
class Component {
	constructor(robot) {this._robot = robot}
	get _stub() {return this._robot._stub}
}
class Screen extends Component{
	get resolution() {
		return [240, 135]
	}
	async brightness(br, duration=null, fade_speed=null) {
		return await this._stub.rpc('backlight', br==undefined?[]:[br, duration, fade_speed])
	}
	async fill(bgr) {
		var [w, h] = this.resolution;
		await this._stub.rpc('fill', [this.bgr2Color565(bgr), 0, 0, h, w]);
	}
	bgr2Color565([b,g,r]) {
		return (r & 0xF8) << 8 | (g & 0xFC) << 3 | b >> 3
	}
	async display(img, x, y){
		[h, w, c] = img.shape;
		if(!this._in_range([x, y], [x+w-1, y+h-1])) throw 'Image must not exceed dimensions of screen';
		img = np.rot90(img);
        [x, y] = [y, 240-x-w];
		await this._stub.rpc('display', [this._image2data(img), x, y, x+h-1, y+w-1]);
	}
	_in_range(){

	}
	_image2data(img){
		// color = (
	 //    ((bgr_image[:, :, 2] & 0xF8) << 8)
	 //    | ((bgr_image[:, :, 1] & 0xFC) << 3)
	 //    | (bgr_image[:, :, 0] >> 3)
	 //    )
	 //    return np.dstack(((color >> 8) & 0xFF, color & 0xFF)).flatten().tolist()
	}
}
class Lift extends Component{
	constructor(robot){
		super(robot);
		this.autoRelaxDelay = 1;
	}
	get maxHeight(){return 1}
	get minHeight(){return 0}
	async height(height, duration=null, speed=null) {
		if (duration && speed)
			throw 'Cannot set both duration and speed';
		this._timeout && clearTimeout(this._timeout);
		var ret = await this._stub.rpc('lift', height==undefined?[]:[height, duration, speed]);
		this._timeout = setTimeout(this.autoRelaxDelay*1000, this._stub.rpc('lift', [null]))
		return ret;
	}
}
class Head extends Component{
	constructor(robot){
		super(robot);
		this.autoRelaxDelay = 1;
	}
	get maxAngle(){return 20}
	get minAngle(){return -20}
	async angle(angle, duration=null, speed=null) {
		if (duration && speed)
			throw 'Cannot set both duration and speed';
		this._timeout && clearTimeout(this._timeout);
		var ret = await this._stub.rpc('head', angle==undefined?[]:[angle, duration, speed]);
		this._timeout = setTimeout(this.autoRelaxDelay*1000, this._stub.rpc('head', [null]))
		return ret;
	}
}
class Motor extends Component{
	async speed(sp, duration=null) {
		return await this._stub.rpc('speed', sp==undefined?[]:[sp, duration])
	}
}
class OutputStreamComponent extends Component{
	get closed() {return !this._task || this._task.done}
	getFrame() {
		this.open()
		return new Promise((r,j)=>{
			this._waitingList.push(new rj(r,j))
		})
	}
	close() {
		if (this.closed) return;
		this._task.resolve();
		this._rpc.cancel();
		var waiting;
		while(waiting=this._waitingList.pop())
			waiting.reject();
	}
	open() {		
		if (!this.closed) return;
		this._waitingList = [];
		new Promise((r,j)=>{
			this._task = new rj(r,j);
			this._rpc = this._createRpc();
			(async ()=>{
				for await(var f of this._rpc) {
					if (this._waitingList.length) {
						// f = this._decode(f);
						var waiting;
						while(waiting=this._waitingList.pop())
							waiting.resolve(f)
						this._lastRequest = Date.now();
					} else if (Date.now()-this._lastRequest > 3){
						this.close();
					}
				}
			})();
		});
	}
}
class Camera extends OutputStreamComponent{
	constructor(robot) {
		super(robot);
		this._resolution = [480, 360];
		this._framerate = 5;
	}
	get resolution(){return this._resolution }
	get framerate(){return this._framerate}
	set resolution(res){
		if (!this.closed)
			throw 'Cannot set resolution while camera is running';
		this._resolution = res;
	}
	set framerate(fr) {
		if (!this.closed)
			throw 'Cannot set resolution while camera is running';
		this._framerate = fr;
	}
	_createRpc() {
		const [w, h] = this.resolution;
		return this._stub.rpc('camera', [w, h, this.framerate]);
	}
}
class Microphone extends OutputStreamComponent{
	constructor(robot) {
		super(robot);
		this._samplerate = 16000;
		this._dtype = 'int16';
		this._frameTime = 0.1;
	}
	get samplerate(){return this._samplerate }
	get frameTime(){return this._frameTime}
	get dtype(){return this._dtype}
	get channels(){return 1}
	set samplerate(sr){
		if (!this.closed)
			throw 'Cannot set resolution while microphone is running';
		this._samplerate = sr;
	}
	set frameTime(ft) {
		if (!this.closed)
			throw 'Cannot set resolution while microphone is running';
		this._frameTime = ft;
	}
	_createRpc() {return this._stub.rpc('microphone', [this.samplerate, this.dtype, this.frameTime])}	
}
class InputStreamComponent extends Component{
	constructor(robot) {
		super(robot);
		this._closed = true;
	}
	get closed() {return this._closed}
	putFrame(f) {
		if (this.closed) throw 'putFrame() called before open()';
		this._inQ.put_nowait(f, true);
	}
	close() {
		if (this.closed) return;
		this._inQ.close();
		this._closed = true;
	}
	open() {		
		if (!this.closed) return;
		[this._rpc, this._inQ] = this._createRpcAndQ();
		this._closed = false;
	}
}
class Buzzer extends InputStreamComponent{	
	constructor(robot) {
		super(robot);
		this._tones = 'CCDDEFFGGAAB';
		this._semitones = {
	        '♭': -1,
	        'b': -1,
	        '♮': 0,
	        '':  0,
	        '♯': 1,
	        '#': 1,};
	}
	_createRpcAndQ(){
		var q = new Queue();
		return [this._stub.rpc('play',[],q), q];
	}
	async quiet() {this.close(); await this._stub.rpc('tone', [null, null])}
	async tone(t, duration){
		if (t==undefined) return this._tone;
		else if(!this.closed) throw 'Cannot set tone while buzzer is playing';
		else await this._stub.rpc('tone', [this._2freq(t), duration]);
	}
	async play(song, tempo=120, duty_cycle=0.9){
		if (duty_cycle>1 || duty_cycle <=0) throw 'duty_cycle out of range (0, 1]';		
		try {
			this.open();
			var delay = 60/tempo;
			if (song instanceof Array) {
				for(tone of song) {
					if (this.closed) return;
					await this._play_one_tone(tone, delay, duty_cycle);
				}
			} else if (typeof song =='string') {
				song = song.replace(/\(/g,',(,').replace(/\)/g,',),').split(/[\s,]+/);
				for (var t of song) {
					if (this.closed) return;
					if (t=='(') delay/=2;
					else if (t==')') delay*=2;
					else {
						await this._inQ.put_nowait(this._2freq(t));
						await sleep(delay*duty_cycle);
						if (duty_cycle!=1) {
							await this._inQ.put_nowait(null);
							await sleep(delay*(1-duty_cycle));
						}
					}
				}
			}
		} catch(e) {
			console.error(e);
		} finally {
			await this._inQ.put_nowait(null, true);
			this.close();
		}
	}
	async _play_one_tone(tone, delay, duty_cycle){
		if (tone instanceof Array){
			for (t of tone)
				this._play_one_tone(t, delay/2, duty_cycle);
		}else {
			await this._inQ.put_nowait(this._2freq(tone))
			await sleep(delay*duty_cycle)
			if (duty_cycle!=1){
				await this._inQ.put_nowait(null);
				await sleep(delay*(1-duty_cycle));
			}
		}
	}
	_2freq(note) {
		if (typeof note == 'string')
			return this._note2freq(note);
		else if (typeof note == 'number' && note >0 && note < 128)
			return this._midi2freq(note);
		else
			return note;
	}
	_midi2freq(midi_note){
		var midi = parseInt(midi_note);
		return  2 ** ((midi-69)/12) * 440;			
	}
	_note2freq(note) {
		return this._midi2freq(this._tones.indexOf(note[0])+(note.length==3?this._semitones[note[1]]:0)+parseInt(note[note.length-1])*12+12)
	}
}
class EyeAnimation extends Component {
	constructor(robot) {
		super(robot);
		this._size = 80;
		this._radius = this._size /4;
		this._gap = 20;
		this._color = (255,255,0);
		this._q = new Queue();
		this._canvas = new cv.Mat.zeros(135, 240);
	}
	get expression() {return this._expression.split('.')[0]}
	set expression(exp) {this._q.put_nowait(exp, true)}
	get expression_list() {return ['auto', 'happy', 'sad', 'surprised', 'angry', 'neutral', 'focused', 'sleepy']}
	get color() {return this._color}
	set color(c) {this._color = c; this._create_eye()}
	_create_eye() {
		if(!this._eye)
			this._eye = new cv.Mat.zeros(this._size, this._size, cv.CV_8U);
		this._eye.rectangle((this._radius, 0), (this._size-this._radius, this._size), this._color);
		this._eye.rectangle((0, this._radius), (this._size, this._size-this._radius), this._color);
		this._eye.circle((this._radius, this._radius), this._radius, this._color);
		this._eye.circle((this._size-this._radius, this._size-this._radius), this._radius, this._color);
		this._eye.circle((this._radius, this._size-this._radius), this._radius, this._color);
		this._eye.circle((this._size-this._radius, this._radius), this._radius, this._color);
	}
	async animate(robot, ignored){
		
	}
}
