"""Read 16 kHz mono PCM from the Rust capture client, emit wake and transcript events."""
import collections
import json
import os
import re
import sys
from pathlib import Path
import numpy as np
import sentencepiece
import sherpa_onnx as so

def models(root):
    kws=root/"sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
    stt=root/"sherpa-onnx-whisper-base"
    tokenizer=sentencepiece.SentencePieceProcessor(model_file=str(kws/"bpe.model"))
    words=root/"st-keywords.txt"
    words.write_text("\n".join(" ".join(tokenizer.encode(phrase,out_type=str))+" @ST" for phrase in ["HEY S T","HEY ESS TEE"])+"\n")
    def part(prefix):return str(next(kws.glob(prefix+"*.int8.onnx")))
    spotter=so.KeywordSpotter(str(kws/"tokens.txt"),part("encoder"),part("decoder"),part("joiner"),str(words),num_threads=1)
    recognizer=so.OfflineRecognizer.from_whisper(str(stt/"base-encoder.int8.onnx"),str(stt/"base-decoder.int8.onnx"),str(stt/"base-tokens.txt"),language=os.getenv("STAPP_LANGUAGE","en"),num_threads=2)
    return spotter,recognizer

def transcribe(recognizer,audio):
    stream=recognizer.create_stream()
    stream.accept_waveform(16000,audio)
    recognizer.decode_stream(stream)
    return re.sub(r"^\s*(?:hey[, ]+)?(?:s\.?\s*t\.?\b|ess\s+tee\b)[,.!?\s]*","",stream.result.text.strip(),flags=re.I).strip()

def main():
    root=Path(os.environ["STAPP_MODELS"]); spotter,rec=models(root)
    mute=Path(os.environ["STAPP_CLIENT_STATE"])/"muted"
    speaking=mute.with_name("speaking")
    stream=spotter.create_stream();pre=collections.deque(maxlen=20);active=None;silent=0
    while raw:=sys.stdin.buffer.read(1280):
        if len(raw)%2:break
        if mute.exists() or speaking.exists():
            pre.clear();active=None;stream=spotter.create_stream();continue
        audio=np.frombuffer(raw,dtype="<i2").astype(np.float32)/32768
        if active is None:
            pre.append(audio);stream.accept_waveform(16000,audio)
            while spotter.is_ready(stream):
                spotter.decode_stream(stream)
                if spotter.get_result(stream):
                    print(json.dumps({"event":"wake"}),flush=True)
                    active=list(pre);silent=0;break
        else:
            active.append(audio)
            silent=silent+1 if np.sqrt(np.mean(audio*audio))<float(os.getenv("STAPP_SILENCE_RMS","0.009")) else 0
            if (len(active)>30 and silent>=20) or len(active)>=275:
                text=transcribe(rec,np.concatenate(active))
                print(json.dumps({"event":"text","text":text}),flush=True)
                active=None;pre.clear();stream=spotter.create_stream()
if __name__=="__main__":main()
