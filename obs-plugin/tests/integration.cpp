#include "../src/PluginContext.hpp"
#include "../src/ReceiverBridge.hpp"
#include <util/platform.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace {
ReceiverBridge testReceiver;
struct AudioProbe {
  std::atomic<uint64_t> frames = 0;
  std::atomic<uint64_t> crossings = 0;
  float previous = 0;
};

void captureAudio(void *context, obs_source_t *, const audio_data *audio, bool)
{
  auto &probe = *static_cast<AudioProbe *>(context);
  const auto *samples = reinterpret_cast<const float *>(audio->data[0]);
  for (uint32_t index = 0; index < audio->frames; ++index) {
    if (probe.previous <= 0 && samples[index] > 0) ++probe.crossings;
    probe.previous = samples[index];
  }
  probe.frames += audio->frames;
}

void require(bool condition, const std::string &message) { if (!condition) throw std::runtime_error(message); }

bool waitForParticipants()
{
  for (int attempt = 0; attempt < 300; ++attempt) {
    if (testReceiver.snapshot().participants.size() == 2) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  return false;
}

void checkFrequency(const AudioProbe &probe, double expected)
{
  const double frequency = static_cast<double>(probe.crossings) * 48'000 / static_cast<double>(probe.frames);
  require(probe.frames > 48'000, "OBS did not capture enough audio frames.");
  require(std::abs(frequency - expected) < 5, "Participant crossfeed or invalid PCM frequency: " + std::to_string(frequency));
  std::cout << "PASS: OBS source " << expected << " Hz, received " << frequency << " Hz (" << probe.frames << " frames)\n";
}
}

ReceiverBridge &receiver() { return testReceiver; }
void showSettingsWindow() {}

int wmain(int count, wchar_t **arguments)
{
  if (count != 3) return 2;
  try {
    require(obs_startup("en-US", nullptr, nullptr), "libobs could not start.");
    if (std::wstring(arguments[1]) == L"--check-settings") {
      const auto migratedSettings = loadSettings(utf8(arguments[2]));
      validateSettings(migratedSettings);
      std::cout << "PASS: Native plugin can decrypt and validate the saved connection settings\n";
      obs_shutdown();
      return 0;
    }
    obs_audio_info audio{48'000, SPEAKERS_STEREO};
    require(obs_reset_audio(&audio), "OBS audio initialization failed.");
    registerParticipantSource();
    ConnectionSettings settings{"test-token-never-a-real-credential", "111111111111111111", "222222222222222222", "", false};
    const auto settingsFile = utf8(arguments[2]);
    saveSettings(settingsFile, settings);
    require(loadSettings(settingsFile).token == settings.token, "DPAPI token round trip failed.");
    std::ifstream encrypted{std::filesystem::path(arguments[2])};
    const std::string contents((std::istreambuf_iterator<char>(encrypted)), {});
    require(contents.find(settings.token) == std::string::npos, "Token was written in plaintext.");
    std::cout << "PASS: Windows DPAPI credential storage\n";
    testReceiver.start(std::filesystem::relative(arguments[1]).wstring());
    testReceiver.command("test");
    const bool participantsReady = waitForParticipants();
    const auto snapshot = testReceiver.snapshot();
    require(participantsReady, "Managed helper did not discover both test participants: " + snapshot.status + " / " + snapshot.error);
    auto *sourceSettings = obs_data_create();
    obs_data_set_string(sourceSettings, "user_id", "111111111111111111");
    auto *firstSource = obs_source_create("discord_voice_participant", "First test voice", sourceSettings, nullptr);
    obs_data_set_string(sourceSettings, "user_id", "222222222222222222");
    auto *secondSource = obs_source_create("discord_voice_participant", "Second test voice", sourceSettings, nullptr);
    require(firstSource && secondSource, "Participant source registration failed.");
    AudioProbe firstProbe, secondProbe;
    obs_source_add_audio_capture_callback(firstSource, captureAudio, &firstProbe);
    obs_source_add_audio_capture_callback(secondSource, captureAudio, &secondProbe);
    std::this_thread::sleep_for(std::chrono::milliseconds(2200));
    testReceiver.command("disconnect");
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    checkFrequency(firstProbe, 440);
    checkFrequency(secondProbe, 880);
    const auto frameCount = firstProbe.frames.load();
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    require(firstProbe.frames == frameCount, "Disconnect did not stop audio.");
    std::cout << "PASS: Disconnect stops audio\n";
    obs_source_remove_audio_capture_callback(firstSource, captureAudio, &firstProbe);
    obs_source_remove_audio_capture_callback(secondSource, captureAudio, &secondProbe);
    obs_source_release(firstSource); obs_source_release(secondSource); obs_data_release(sourceSettings);
    testReceiver.stop();
    obs_wait_for_destroy_queue();
    obs_shutdown();
    std::cout << "PASS: Helper and sources shut down cleanly\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    testReceiver.stop();
    return 1;
  }
}
