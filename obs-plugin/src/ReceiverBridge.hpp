#pragma once
#include <windows.h>
#include <obs.h>
#include <atomic>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "SettingsStore.hpp"

struct Participant {
  std::string userId;
  std::string name;
  uint64_t packets = 0;
};

struct ReceiverSnapshot {
  std::string status;
  std::string error;
  std::vector<Participant> participants;
  bool running = false;
};

/** Owns a private receiver process and distributes each user's PCM to registered OBS sources. */
class ReceiverBridge {
public:
  ~ReceiverBridge();
  void start(const std::wstring &helperDirectory);
  void stop();
  void connect(const ConnectionSettings &settings);
  void command(const char *command);
  ReceiverSnapshot snapshot();
  void addSource(obs_source_t *source, const std::string &userId);
  void removeSource(obs_source_t *source);

private:
  struct SourceRoute { obs_weak_source_t *source; std::string userId; };
  void send(obs_data_t *command);
  void sendJson(const std::string &json);
  void readFrames();
  void handleEvent(const std::string &json);
  void handleAudio(const std::vector<uint8_t> &frame);
  bool readExact(void *buffer, DWORD size);
  std::mutex stateMutex;
  std::mutex writeMutex;
  std::mutex routesMutex;
  std::vector<SourceRoute> routes;
  std::map<std::string, Participant> participants;
  std::string status = "Receiver not started";
  std::string lastError;
  HANDLE process = nullptr;
  HANDLE processJob = nullptr;
  HANDLE childInput = nullptr;
  HANDLE childOutput = nullptr;
  std::thread reader;
  std::atomic<bool> running = false;
  std::atomic<bool> stopping = false;
  uint64_t firstRemoteTimestamp = 0;
  uint64_t firstLocalTimestamp = 0;
};

ReceiverBridge &receiver();
