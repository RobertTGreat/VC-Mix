#include "ReceiverBridge.hpp"
#include <util/platform.h>
#include <algorithm>
#include <cstring>
#include <filesystem>
#include <memory>
#include <sstream>
#include <stdexcept>

namespace {
constexpr uint32_t MAXIMUM_FRAME_BYTES = 1'048'576;
constexpr uint8_t EVENT_FRAME = 1;
constexpr uint8_t AUDIO_FRAME = 2;
constexpr uint32_t SAMPLE_RATE = 48'000;
constexpr uint32_t STEREO_FRAME_BYTES = 4;
using ObsData = std::unique_ptr<obs_data_t, decltype(&obs_data_release)>;

void closeHandle(HANDLE &handle)
{
  if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  handle = nullptr;
}
}

ReceiverBridge::~ReceiverBridge()
{
  stop();
  for (const auto &route : routes) obs_weak_source_release(route.source);
}

void ReceiverBridge::start(const std::wstring &helperDirectory)
{
  stop();
  // OBS's built-in plugin search paths can be relative to bin/64bit. The child has a different working directory.
  const auto absoluteHelperDirectory = std::filesystem::absolute(helperDirectory).lexically_normal().wstring();
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  HANDLE inputRead = nullptr;
  HANDLE outputWrite = nullptr;
  HANDLE nullOutput = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
  if (!CreatePipe(&inputRead, &childInput, &security, 0) || !CreatePipe(&childOutput, &outputWrite, &security, 0)) {
    closeHandle(inputRead); closeHandle(outputWrite); closeHandle(nullOutput); stop();
    throw std::runtime_error("Could not create the receiver's audio pipes.");
  }
  SetHandleInformation(childInput, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(childOutput, HANDLE_FLAG_INHERIT, 0);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inputRead;
  startup.StartupInfo.hStdOutput = outputWrite;
  startup.StartupInfo.hStdError = nullOutput;
  SIZE_T attributeBytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
  std::vector<uint8_t> attributeStorage(attributeBytes);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributeStorage.data());
  const HANDLE inherited[] = {inputRead, outputWrite, nullOutput};
  const bool attributesReady = InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributeBytes)
    && UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        const_cast<HANDLE *>(inherited), sizeof(inherited), nullptr, nullptr);
  PROCESS_INFORMATION child{};
  const auto executable = absoluteHelperDirectory + L"\\node.exe";
  std::wstring arguments = L"\"" + executable + L"\" \"" + absoluteHelperDirectory + L"\\src\\obs\\helper.js\"";
  const bool started = attributesReady && CreateProcessW(executable.c_str(), arguments.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, nullptr, absoluteHelperDirectory.c_str(), &startup.StartupInfo, &child);
  if (attributesReady) DeleteProcThreadAttributeList(startup.lpAttributeList);
  closeHandle(inputRead); closeHandle(outputWrite); closeHandle(nullOutput);
  if (!started) { stop(); throw std::runtime_error("Receiver could not start. Reinstall the complete plugin, including data/helper/node.exe."); }
  process = child.hProcess;
  processJob = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (processJob) {
    SetInformationJobObject(processJob, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
    AssignProcessToJobObject(processJob, process);
  }
  stopping = false;
  running = true;
  firstRemoteTimestamp = 0;
  { std::lock_guard lock(stateMutex); status = "Starting receiver…"; lastError.clear(); participants.clear(); }
  ResumeThread(child.hThread);
  CloseHandle(child.hThread);
  reader = std::thread(&ReceiverBridge::readFrames, this);
}

void ReceiverBridge::stop()
{
  stopping = true;
  { std::lock_guard lock(writeMutex); closeHandle(childInput); }
  if (process && WaitForSingleObject(process, 1500) == WAIT_TIMEOUT) TerminateProcess(process, 0);
  if (reader.joinable()) reader.join();
  closeHandle(childOutput); closeHandle(process); closeHandle(processJob);
  running = false;
}

void ReceiverBridge::send(obs_data_t *data)
{
  sendJson(obs_data_get_json(data));
}

void ReceiverBridge::sendJson(const std::string &message)
{
  std::lock_guard writeLock(writeMutex);
  if (!running || !childInput) throw std::runtime_error("The receiver is stopped. Close and reopen VC Mix to restart it.");
  const std::string json = message + "\n";
  DWORD written = 0;
  if (!WriteFile(childInput, json.data(), static_cast<DWORD>(json.size()), &written, nullptr) || written != json.size())
    throw std::runtime_error("The receiver stopped responding. Reopen VC Mix and reconnect.");
  { std::lock_guard stateLock(stateMutex); lastError.clear(); }
}

void ReceiverBridge::connect(const ConnectionSettings &settings)
{
  validateSettings(settings);
  ObsData data(obs_data_create(), obs_data_release);
  obs_data_set_string(data.get(), "command", "connect");
  obs_data_set_string(data.get(), "token", settings.token.c_str());
  obs_data_set_string(data.get(), "guildId", settings.guildId.c_str());
  obs_data_set_string(data.get(), "channelId", settings.channelId.c_str());
  std::string ids = settings.excludedIds;
  for (char &character : ids) if (character == ',') character = ' ';
  std::istringstream identifiers(ids);
  // All IDs were validated as digits, so they require no additional JSON escaping.
  std::string arrayJson = "[";
  std::string identifier;
  while (identifiers >> identifier) { if (arrayJson.size() > 1) arrayJson += ','; arrayJson += '"' + identifier + '"'; }
  arrayJson += ']';
  std::string json = obs_data_get_json(data.get());
  json.insert(json.find_last_of('}'), ",\"ignoredUserIds\":" + arrayJson);
  // libobs arrays contain objects; preserve the validated primitive array in the wire JSON.
  sendJson(json);
}

void ReceiverBridge::command(const char *name)
{
  ObsData data(obs_data_create(), obs_data_release);
  obs_data_set_string(data.get(), "command", name);
  send(data.get());
}

ReceiverSnapshot ReceiverBridge::snapshot()
{
  std::lock_guard lock(stateMutex);
  ReceiverSnapshot snapshot{status, lastError, {}, running.load()};
  for (const auto &[userId, participant] : participants) snapshot.participants.push_back(participant);
  return snapshot;
}

bool ReceiverBridge::readExact(void *buffer, DWORD size)
{
  auto *cursor = static_cast<uint8_t *>(buffer);
  while (size) {
    DWORD received = 0;
    if (!ReadFile(childOutput, cursor, size, &received, nullptr) || !received) return false;
    cursor += received; size -= received;
  }
  return true;
}

void ReceiverBridge::readFrames()
{
  uint32_t size = 0;
  while (readExact(&size, sizeof(size))) {
    if (size == 0 || size > MAXIMUM_FRAME_BYTES) break;
    std::vector<uint8_t> frame(size);
    if (!readExact(frame.data(), size)) break;
    if (frame[0] == EVENT_FRAME) handleEvent(std::string(frame.begin() + 1, frame.end()));
    if (frame[0] == AUDIO_FRAME) handleAudio(frame);
  }
  running = false;
  if (!stopping) {
    std::lock_guard lock(stateMutex);
    status = "Receiver stopped";
    lastError = "The background receiver exited. Reopen Tools > VC Mix to restart it.";
    participants.clear();
  }
}

void ReceiverBridge::handleEvent(const std::string &json)
{
  ObsData event(obs_data_create_from_json(json.c_str()), obs_data_release);
  if (!event) return;
  const std::string type = obs_data_get_string(event.get(), "type");
  std::lock_guard lock(stateMutex);
  if (type == "ready") status = "Disconnected — enter your settings and connect";
  else if (type == "status") status = obs_data_get_string(event.get(), "message");
  else if (type == "error") lastError = obs_data_get_string(event.get(), "message");
  else if (type == "reset") { participants.clear(); firstRemoteTimestamp = 0; }
  else if (type == "left") participants.erase(obs_data_get_string(event.get(), "userId"));
  else if (type == "participant") {
    const std::string userId = obs_data_get_string(event.get(), "userId");
    participants.insert_or_assign(userId, Participant{userId, obs_data_get_string(event.get(), "name"), 0});
  }
}

void ReceiverBridge::handleAudio(const std::vector<uint8_t> &frame)
{
  if (frame.size() < 2) return;
  const size_t idBytes = frame[1];
  const size_t pcmOffset = 2 + idBytes + sizeof(uint64_t);
  if (idBytes < 17 || idBytes > 20 || frame.size() <= pcmOffset || (frame.size() - pcmOffset) % STEREO_FRAME_BYTES) return;
  const std::string userId(frame.begin() + 2, frame.begin() + 2 + idBytes);
  if (userId.find_first_not_of("0123456789") != std::string::npos) return;
  uint64_t remoteTimestamp = 0;
  memcpy(&remoteTimestamp, frame.data() + 2 + idBytes, sizeof(remoteTimestamp));
  if (!firstRemoteTimestamp) { firstRemoteTimestamp = remoteTimestamp; firstLocalTimestamp = os_gettime_ns(); }
  if (remoteTimestamp < firstRemoteTimestamp) return;
  obs_source_audio audio{};
  audio.data[0] = const_cast<uint8_t *>(frame.data() + pcmOffset);
  audio.frames = static_cast<uint32_t>((frame.size() - pcmOffset) / STEREO_FRAME_BYTES);
  audio.speakers = SPEAKERS_STEREO;
  audio.format = AUDIO_FORMAT_16BIT;
  audio.samples_per_sec = SAMPLE_RATE;
  audio.timestamp = firstLocalTimestamp + remoteTimestamp - firstRemoteTimestamp;
  std::vector<obs_source_t *> targets;
  { std::lock_guard lock(routesMutex);
    for (const auto &route : routes) {
      if (route.userId != userId) continue;
      if (auto *source = obs_weak_source_get_source(route.source)) targets.push_back(source);
    }
  }
  for (auto *source : targets) { obs_source_output_audio(source, &audio); obs_source_release(source); }
  { std::lock_guard lock(stateMutex);
    if (auto found = participants.find(userId); found != participants.end()) ++found->second.packets;
  }
}

void ReceiverBridge::addSource(obs_source_t *source, const std::string &userId)
{
  removeSource(source);
  std::lock_guard lock(routesMutex);
  routes.push_back({obs_source_get_weak_source(source), userId});
}

void ReceiverBridge::removeSource(obs_source_t *source)
{
  std::lock_guard lock(routesMutex);
  std::erase_if(routes, [source](const SourceRoute &route) {
    if (!obs_weak_source_references_source(route.source, source)) return false;
    obs_weak_source_release(route.source);
    return true;
  });
}
