#include "SettingsStore.hpp"
#include <windows.h>
#include <wincrypt.h>
#include <obs.h>
#include <filesystem>
#include <memory>
#include <regex>
#include <sstream>
#include <stdexcept>

namespace {
using ObsData = std::unique_ptr<obs_data_t, decltype(&obs_data_release)>;
constexpr char HEX_DIGITS[] = "0123456789abcdef";

std::string encryptToken(const std::string &token)
{
  if (token.empty()) return {};
  DATA_BLOB input{static_cast<DWORD>(token.size()), reinterpret_cast<BYTE *>(const_cast<char *>(token.data()))};
  DATA_BLOB encrypted{};
  if (!CryptProtectData(&input, L"VC Mix OBS bot token", nullptr, nullptr, nullptr,
                        CRYPTPROTECT_UI_FORBIDDEN, &encrypted))
    throw std::runtime_error("Windows could not encrypt the bot token. Settings were not saved.");
  std::string result;
  result.reserve(encrypted.cbData * 2);
  for (DWORD byteIndex = 0; byteIndex < encrypted.cbData; ++byteIndex) {
    result += HEX_DIGITS[encrypted.pbData[byteIndex] >> 4];
    result += HEX_DIGITS[encrypted.pbData[byteIndex] & 15];
  }
  LocalFree(encrypted.pbData);
  return result;
}

std::string decryptToken(const std::string &encoded)
{
  if (encoded.empty()) return {};
  if (encoded.size() % 2 || encoded.size() > 16'384 || encoded.find_first_not_of(HEX_DIGITS) != std::string::npos)
    throw std::runtime_error("Saved credentials are damaged. Re-enter the bot token and save.");
  std::string bytes;
  for (size_t index = 0; index < encoded.size(); index += 2)
    bytes += static_cast<char>(std::stoi(encoded.substr(index, 2), nullptr, 16));
  DATA_BLOB input{static_cast<DWORD>(bytes.size()), reinterpret_cast<BYTE *>(bytes.data())};
  DATA_BLOB decrypted{};
  if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &decrypted))
    throw std::runtime_error("Windows could not unlock the saved token. Re-enter it on this Windows account.");
  std::string result(reinterpret_cast<char *>(decrypted.pbData), decrypted.cbData);
  SecureZeroMemory(decrypted.pbData, decrypted.cbData);
  LocalFree(decrypted.pbData);
  return result;
}
}

std::wstring wide(const std::string &text)
{
  if (text.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring result(count, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), count);
  return result;
}

std::string utf8(const std::wstring &text)
{
  if (text.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  std::string result(count, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), count, nullptr, nullptr);
  return result;
}

void validateSettings(const ConnectionSettings &settings)
{
  static const std::regex snowflake("^[0-9]{17,20}$");
  if (settings.token.size() < 20 || settings.token.size() > 512)
    throw std::runtime_error("Enter your Discord bot token before connecting.");
  if (!std::regex_match(settings.guildId, snowflake) || !std::regex_match(settings.channelId, snowflake))
    throw std::runtime_error("Server ID and voice channel ID must each contain 17 to 20 digits.");
  std::string normalized = settings.excludedIds;
  for (char &character : normalized) if (character == ',') character = ' ';
  std::istringstream identifiers(normalized);
  std::string identifier;
  size_t count = 0;
  while (identifiers >> identifier) {
    if (!std::regex_match(identifier, snowflake) || ++count > 100)
      throw std::runtime_error("Excluded IDs must be Discord user IDs separated by spaces or commas (maximum 100).");
  }
}

ConnectionSettings loadSettings(const std::string &path)
{
  ObsData data(obs_data_create_from_json_file(path.c_str()), obs_data_release);
  if (!data) return {};
  ConnectionSettings settings;
  settings.guildId = obs_data_get_string(data.get(), "guild_id");
  settings.channelId = obs_data_get_string(data.get(), "channel_id");
  settings.excludedIds = obs_data_get_string(data.get(), "excluded_ids");
  settings.autoConnect = obs_data_get_bool(data.get(), "auto_connect");
  settings.token = decryptToken(obs_data_get_string(data.get(), "encrypted_token"));
  return settings;
}

void saveSettings(const std::string &path, const ConnectionSettings &settings)
{
  ObsData data(obs_data_create(), obs_data_release);
  obs_data_set_string(data.get(), "encrypted_token", encryptToken(settings.token).c_str());
  obs_data_set_string(data.get(), "guild_id", settings.guildId.c_str());
  obs_data_set_string(data.get(), "channel_id", settings.channelId.c_str());
  obs_data_set_string(data.get(), "excluded_ids", settings.excludedIds.c_str());
  obs_data_set_bool(data.get(), "auto_connect", settings.autoConnect);
  std::filesystem::create_directories(std::filesystem::path(wide(path)).parent_path());
  if (!obs_data_save_json_safe(data.get(), path.c_str(), "tmp", "bak"))
    throw std::runtime_error("Could not write the plugin settings file. Check the folder permissions.");
}
