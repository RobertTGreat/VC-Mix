#pragma once
#include <string>

struct ConnectionSettings {
  std::string token;
  std::string guildId;
  std::string channelId;
  std::string excludedIds;
  bool autoConnect = false;
};

ConnectionSettings loadSettings(const std::string &path);
void saveSettings(const std::string &path, const ConnectionSettings &settings);
void validateSettings(const ConnectionSettings &settings);
std::wstring wide(const std::string &text);
std::string utf8(const std::wstring &text);
