'use strict';

var
    // import stuff from AudioNetwork lib
    Audio = AudioNetwork.Injector.resolve('PhysicalLayer.Audio'),
    CarrierRecovery = AudioNetwork.Injector.resolve('PhysicalLayer.CarrierRecovery'),
    CarrierGenerate = AudioNetwork.Injector.resolve('PhysicalLayer.CarrierGenerate'),
    PowerChart = AudioNetwork.PhysicalLayer.PowerChart,
    Queue = AudioNetwork.Common.Queue,

    // +--+            +--+            +--+            +--+            +--+            +--+
    //     +--+            +--+            +--+            +--+            +--+            +--+
    //         +--+            +--+            +--+            +--+            +--+            +--+
    //             +--+            +--+            +--+            +--+            +--+            +--+
    // ----------------################--------------------------------################----------------
    //                    _____________                                   _____________
    // ________________,-`             `-,_____________________________,-`             `-,_____________

    // +------+        +------+        +------+        +------+        +------+        +------+
    //     +------+        +------+        +------+        +------+        +------+        +------+
    //         +------+        +------+        +------+        +------+        +------+        +------+
    //             +-------+       +------+        +------+        +------+        +------+        +------+
    // ----------------################--------------------------------################--------------------
    //                        _________                                       _________
    // ________________,---```         ```---,_________________________,---```         ```---,_____________

    LOOPBACK_ACTIVE = 0,
    WHITE_NOISE_ACTIVE = 0,
    REFRESH_POWER_INFO_ACTIVE = 0,
    POWER_CHART_ACTIVE = 1,

    SUB_CARRIER_SIZE = 8,
    PILOT_FREQUENCY = 5000,                                                       // Hz
    POWER_CHART_WIDTH = 200,                                                      // px
    POWER_CHART_HEIGHT = 10 * 20,                                                 // px
    THRESHOLD = -30,                                                              // dB
    MINIMUM_POWER_DECIBEL = -99,                                                  // dB

    SYMBOL_TIME = 2.0 * 0.08,                                                     // seconds
    GUARD_TIME = 1.5 * SYMBOL_TIME,                                               // seconds
    DFT_WINDOW_TIME = 0.5 * SYMBOL_TIME,                                          // seconds
    NOTIFY_TIME = (1 / 16) * SYMBOL_TIME,                                          // seconds
    SAMPLE_PER_SYMBOL = Math.round(Audio.getSampleRate() * SYMBOL_TIME),
    SAMPLE_PER_GUARD = Math.round(Audio.getSampleRate() * GUARD_TIME),
    SAMPLE_PER_DFT_WINDOW = Math.round(Audio.getSampleRate() * DFT_WINDOW_TIME),
    SAMPLE_PER_NOTIFY = Math.round(Audio.getSampleRate() * NOTIFY_TIME),

    OFDM_FREQUENCY_SPACING = 1 / DFT_WINDOW_TIME,                                 // Hz

    // normal variables
    scriptProcessorNodeSpeaker = Audio.createScriptProcessor(4096, 1, 1),
    scriptProcessorNodeMicrophone = Audio.createScriptProcessor(4096, 1, 1),
    analyserNode = Audio.createAnalyser(),
    sampleGlobalCountMicrophone = 0,
    carrierGeneratePilot,
    carrierRecoveryPilot,
    carrierGenerate = [],
    carrierRecovery = [],
    pilotPrevious = false,
    carrierDetailHistory = [],
    powerChartPilot,
    powerChart = [];


function initCarrierObject() {
    var frequency, samplePerPeriod, i;

    samplePerPeriod = Audio.getSampleRate() / PILOT_FREQUENCY;
    carrierGeneratePilot = new CarrierGenerate(samplePerPeriod);
    carrierRecoveryPilot = new CarrierRecovery(samplePerPeriod, SAMPLE_PER_DFT_WINDOW);

    for (i = 0; i < SUB_CARRIER_SIZE; i++) {
        frequency = PILOT_FREQUENCY + (i + 1) * OFDM_FREQUENCY_SPACING;
        samplePerPeriod = Audio.getSampleRate() / frequency;

        carrierGenerate.push(new CarrierGenerate(samplePerPeriod));
        carrierRecovery.push(new CarrierRecovery(samplePerPeriod, SAMPLE_PER_DFT_WINDOW));
    }
}

function initNode() {
    scriptProcessorNodeSpeaker.onaudioprocess = scriptProcessorNodeSpeakerHandler;
    scriptProcessorNodeMicrophone.onaudioprocess = scriptProcessorNodeMicrophoneHandler;

    if (LOOPBACK_ACTIVE) {
        scriptProcessorNodeSpeaker.connect(scriptProcessorNodeMicrophone);
        scriptProcessorNodeMicrophone.connect(analyserNode);
    } else {
        Audio.getMicrophoneNode().connect(scriptProcessorNodeMicrophone);
        scriptProcessorNodeMicrophone.connect(analyserNode);
        scriptProcessorNodeSpeaker.connect(Audio.getDestination());
    }
}

function initPowerChart() {
    var queue, i;

    if (!POWER_CHART_ACTIVE) {
        return;
    }

    queue = new Queue(POWER_CHART_WIDTH);
    powerChartPilot = {
        queue: queue,
        renderer: new PowerChart(
            document.getElementById('power-chart-pilot'), POWER_CHART_WIDTH, POWER_CHART_HEIGHT, queue
        )
    };

    for (i = 0; i < SUB_CARRIER_SIZE; i++) {
        queue = new Queue(POWER_CHART_WIDTH);
        powerChart.push({
            queue: queue,
            renderer: new PowerChart(
                document.getElementById('power-chart-' + i), POWER_CHART_WIDTH, POWER_CHART_HEIGHT, queue
            )
        });
    }
}

function initKeyboardEventGrabber() {
    var element = document.getElementById('keyboard-event-grabber');

    // events: keypress keyup keydown
    element.addEventListener('keypress', function (e) {
        send(e.keyCode);
        e.preventDefault();
    });
}

function init() {
    initPowerChart();
    initCarrierObject();
    initNode();
    initKeyboardEventGrabber();
}

function scriptProcessorNodeSpeakerHandler(audioProcessingEvent) {
    var
        outputData = audioProcessingEvent.outputBuffer.getChannelData(0),
        sample,
        i;

    for (sample = 0; sample < outputData.length; sample++) {
        outputData[sample] = 0;

        outputData[sample] += carrierGeneratePilot.getSample();
        carrierGeneratePilot.nextSample();

        for (i = 0; i < SUB_CARRIER_SIZE; i++) {
            outputData[sample] += carrierGenerate[i].getSample();
            carrierGenerate[i].nextSample();
        }
    }
}

function scriptProcessorNodeMicrophoneHandler(audioProcessingEvent) {
    var
        inputData = audioProcessingEvent.inputBuffer.getChannelData(0),
        sample,
        i;

    for (sample = 0; sample < inputData.length; sample++) {
        if (WHITE_NOISE_ACTIVE) {
            inputData[sample] += (Math.random() * 2 - 1) * 0.01;
        }
        carrierRecoveryPilot.handleSample(inputData[sample]);
        for (i = 0; i < SUB_CARRIER_SIZE; i++) {
            carrierRecovery[i].handleSample(inputData[sample]);
        }
        sampleGlobalCountMicrophone++;
        notifyIfNeeded();
    }
}

function normalizeDecibel(value) {
    if (value === -Infinity) {
        value = MINIMUM_POWER_DECIBEL;
    }
    value = value < MINIMUM_POWER_DECIBEL ? MINIMUM_POWER_DECIBEL : value;

    return value;
}

function notifyIfNeeded() {
    var
        carrierDetail = [],
        carrierDetailTemp,
        i;

    if (sampleGlobalCountMicrophone % SAMPLE_PER_NOTIFY !== 0) {
        return;
    }

    for (i = 0; i < SUB_CARRIER_SIZE; i++) {
        carrierDetailTemp = carrierRecovery[i].getCarrierDetail();
        carrierDetailTemp.powerDecibel = normalizeDecibel(carrierDetailTemp.powerDecibel);
        carrierDetail.push(carrierDetailTemp);
    }

    carrierDetailTemp = carrierRecoveryPilot.getCarrierDetail();
    carrierDetailTemp.powerDecibel = normalizeDecibel(carrierDetailTemp.powerDecibel);

    notifyHandler(carrierDetailTemp, carrierDetail);
}

function notifyHandler(carrierDetailPilot, carrierDetail) {
    var
        pilot = carrierDetailPilot.powerDecibel > THRESHOLD,
        carrierDetailMiddle,
        symbol,
        phase,
        i;

    if (POWER_CHART_ACTIVE) {
        if (powerChartPilot.queue.isFull()) {
            powerChartPilot.queue.pop()
        }
        powerChartPilot.queue.push(carrierDetailPilot.powerDecibel);
        for (i = 0; i < SUB_CARRIER_SIZE; i++) {
            if (powerChart[i].queue.isFull()) {
                powerChart[i].queue.pop()
            }
            powerChart[i].queue.push(carrierDetail[i].powerDecibel);
        }
    }

    if (REFRESH_POWER_INFO_ACTIVE) {
        document.getElementById('power-decibel-pilot').innerHTML = Math.round(carrierDetailPilot.powerDecibel).toString();
        for (i = 0; i < SUB_CARRIER_SIZE; i++) {
            document.getElementById('power-decibel-' + i).innerHTML = Math.round(carrierDetail[i].powerDecibel).toString();
        }
    }

    if (pilot && !pilotPrevious) {
        carrierDetailHistory.length = 0;
    }

    if (pilot) {
        symbol = 0;
        phase = [];
        for (i = 0; i < SUB_CARRIER_SIZE; i++) {
            symbol += carrierDetail[i].powerDecibel > THRESHOLD ? (1 << SUB_CARRIER_SIZE - 1 - i) : 0;
            phase.push(Math.round(carrierDetail[i].phase * 360));
        }
        carrierDetailHistory.push({
            symbol: symbol,
            phase: phase
        });
    }

    if (!pilot && pilotPrevious) {
        carrierDetailMiddle = carrierDetailHistory[Math.floor(carrierDetailHistory.length / 2)];

        // --- console debug ---
        var s = '';
        for (i = 0; i < carrierDetailHistory.length; i++) {
            s += carrierDetailHistory[i].symbol + ',';
        }
        console.log(s);
        console.log('        ', carrierDetailMiddle.phase.join(','));
        // ---------------------

        document.getElementById('symbol').innerHTML += '0x' + carrierDetailMiddle.symbol.toString(16);
        if (carrierDetailMiddle.symbol >= 32 && carrierDetailMiddle.symbol < 128) {
            document.getElementById('symbol').innerHTML += '[' + String.fromCharCode(carrierDetailMiddle.symbol)  + ']';
        }
        document.getElementById('symbol').innerHTML += ' ';
    }

    pilotPrevious = pilot;
}

function send(symbol) {
    var
        binary = '00000000' + (symbol >>> 0).toString(2),
        amplitude = 1 / (1 + SUB_CARRIER_SIZE),
        i;

    carrierGeneratePilot.addToQueue([{ duration: SAMPLE_PER_SYMBOL, phase: 0, amplitude: amplitude }]);
    for (i = 0; i < SUB_CARRIER_SIZE; i++) {
        carrierGenerate[i].addToQueue([{
            duration: SAMPLE_PER_SYMBOL, phase: 0, amplitude: amplitude * binary[binary.length - SUB_CARRIER_SIZE + i]
        }]);
    }

    carrierGeneratePilot.addToQueue([{ duration: SAMPLE_PER_GUARD, phase: 0, amplitude: 0 }]);
    for (i = 0; i < SUB_CARRIER_SIZE; i++) {
        carrierGenerate[i].addToQueue([{
            duration: SAMPLE_PER_GUARD, phase: 0, amplitude: 0
        }]);
    }
}

function sendText(text) {
    var i;

    for (i = 0; i < text.length; i++) {
        send(text.charCodeAt(i));
    }
}