"""Opt-in native audio fixtures; no microphone, server calls or audible playback.

Run after scripts/models.py and a release build. Optional --report saves synthetic
Linux per-process measurements (peak RSS includes fixture buffers and startup).
"""
import argparse
import array
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import wave

ROOT=Path(__file__).resolve().parents[1]
BINARY=ROOT/'target/release'/('st-voice.exe' if os.name=='nt' else 'st-voice')

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--report',type=Path);args=parser.parse_args()
    # Fix synthesis noise so regression inputs are repeatable across runs.
    os.environ['STAPP_TTS_NOISE_SCALE']='0.0001'
    os.environ['STAPP_TTS_NOISE_SCALE_W']='0.0001'
    reports=[]
    with tempfile.TemporaryDirectory(prefix='st-audio-fixtures-') as directory:
        root=Path(directory)
        def run(name,*argv):
            start=time.monotonic()
            with (root/'output').open('w+') as log:
                proc=subprocess.Popen([str(BINARY),*map(str,argv)],stdout=log,stderr=log)
                if hasattr(os,'wait4'):
                    _,status,usage=os.wait4(proc.pid,0);proc.returncode=os.waitstatus_to_exitcode(status)
                    metrics={'cpu_seconds':round(usage.ru_utime+usage.ru_stime,3),'max_rss_mib':round(usage.ru_maxrss/1024,1)}
                else:proc.wait();metrics={}
                log.seek(0);text=log.read()
            if proc.returncode:raise AssertionError(text)
            reports.append({'case':name,'wall_seconds':round(time.monotonic()-start,3),**metrics,'output':text.strip()})
            return text
        def synth(name,text):
            path=root/(name+'.wav');run(name+'-tts','--synthesize',text,'--output',path);return path
        for name,text,expected in [
            ('hey','Hey, ess tee. What is the air quality in this room?',1),
            ('okay','Okay, ess tee. Please list my tasks.',1),
            ('no-wake','Please list my tasks.',0),
            ('neighbor','Hey Steve. Please list my tasks.',0),
        ]:
            path=synth(name,text);result=run(name,'--check-audio',path)
            assert f'confirmed_count: {expected}' in result,(name,result)
            if expected:assert 'transcript:' in result,result
        silence=root/'silence.wav'
        with wave.open(str(silence),'w') as w:
            w.setnchannels(1);w.setsampwidth(2);w.setframerate(48000);w.writeframes(b'\0'*(48000*2*60))
        assert 'wake_count: 0' in run('silence60','--check-audio',silence)
        part=synth('long-part','This is a long dictation test. Please keep every part of the message.')
        tail=synth('long-tail','The final password is cobalt. This is the end of the message.')
        with wave.open(str(part)) as w:params=w.getparams();segment=w.readframes(w.getnframes())
        with wave.open(str(tail)) as w:ending=w.readframes(w.getnframes())
        long=root/'long.wav'
        with wave.open(str(long),'w') as w:
            w.setparams(params);w.writeframes((segment+b'\0'*(params.framerate//2))*12+ending)
        with wave.open(str(long)) as w:duration=w.getnframes()/w.getframerate()
        assert duration>30,duration
        result=run('long-transcription','--transcribe',long)
        assert 'cobalt' in result.lower(),result
        with wave.open(str(root/'hey.wav')) as w:opening=w.readframes(w.getnframes())
        def trim(data):
            values=array.array('h',data)
            audible=[i for i,x in enumerate(values) if abs(x)>100]
            return values[max(0,audible[0]-params.framerate//10):audible[-1]+params.framerate//10].tobytes()
        # Stitch one continuous utterance. Untrimmed TTS files contain sentence
        # tails longer than the endpoint threshold and correctly end capture.
        full=trim(opening)+(trim(segment)+b'\0'*(params.framerate//5))*12+trim(ending)
        with wave.open(str(root/'long-wake.wav'),'w') as w:w.setparams(params);w.writeframes(full)
        result=run('long-wake','--check-audio',root/'long-wake.wav')
        assert 'confirmed_count: 1' in result and 'cobalt' in result.lower(),result
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps({'kind':'synthetic-audio-only','long_audio_seconds':round(duration,2),'cases':reports},indent=2)+'\n')
    print('Passed: Hey ST, Okay ST, two negative phrases, 60s silence, and long transcript tail.')
    for r in reports:
        print(r['case'],r['wall_seconds'],'seconds',r.get('max_rss_mib','n/a'),'MiB peak RSS')

if __name__=='__main__':main()
