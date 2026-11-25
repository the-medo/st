# Voice assistant future work

The current implementation plan is [here](../IMPLEMENTATION.md).

## Android microphone widget

- [ ] Create a minimal Android companion app; no dedicated ST Android app was
  found in this repository.
- [ ] Add one home-screen microphone icon. Tapping starts recording without a
  wake phrase; provide visible recording and stop feedback.
- [ ] Pair a separate phone device and reuse durable request/event delivery and
  the same central classifier/agent coordinator.
- [ ] Request microphone permission at onboarding. Use a documented user-initiated
  activity/entry path and a microphone foreground service when capture continues
  outside the activity. Account for while-in-use restrictions and the recording
  notification; do not start ambient microphone capture at boot.
- [ ] Compare local ASR with bounded audio upload to the home server for battery,
  recognition and latency before choosing the phone implementation.
- [ ] Show transcript, cancel/stop, offline state and compact spoken result;
  retain the full conversation in Herdr.
- [ ] Test screen locking, process death, network changes and duplicate submission.

Reference: [Android foreground-service types](https://developer.android.com/develop/background-work/services/fgs/service-types).

## Additional forms and improvements

- [ ] Browser push-to-talk in the ST console using the shared protocol.
- [ ] Headset/controller button activation on desktop.
- [ ] Echo cancellation and spoken interruption during TTS.
- [ ] Further endpoint languages and voices, selected using actual recordings.
- [ ] Multi-intent or hierarchical routing when measurements justify it.
- [ ] Optional cloud speech/continuous voice frontend, configured independently
  from local classification and subscription-backed agent execution.
