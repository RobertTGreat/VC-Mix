#include "../src/PluginContext.hpp"
#include "../src/ReceiverBridge.hpp"
#include <obs-frontend-api.h>
#include <QApplication>
#include <QCheckBox>
#include <QDialog>
#include <QEventLoop>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QMouseEvent>
#include <QPushButton>
#include <QTimer>
#include <QTreeWidget>
#include <iostream>
#include <stdexcept>

namespace {
ReceiverBridge testReceiver;
ConnectionSettings testSettings;
QWidget *ownerWindow = nullptr;
unsigned savedSettings = 0;
std::string addedUserId;

void require(bool condition, const char *message) { if (!condition) throw std::runtime_error(message); }

void processEvents()
{
  QApplication::processEvents();
  QApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete);
}

void waitForEvents(int milliseconds)
{
  QEventLoop loop;
  QTimer::singleShot(milliseconds, &loop, &QEventLoop::quit);
  loop.exec();
  processEvents();
}

template<typename Widget> Widget *control(QDialog *dialog, const char *name)
{
  auto *widget = dialog->findChild<Widget *>(name);
  require(widget != nullptr, "Expected Qt settings control is missing.");
  return widget;
}

void sendKey(QWidget *widget, int key, const QString &text = {})
{
  QKeyEvent press(QEvent::KeyPress, key, Qt::NoModifier, text);
  QKeyEvent release(QEvent::KeyRelease, key, Qt::NoModifier, text);
  QApplication::sendEvent(widget, &press);
  QApplication::sendEvent(widget, &release);
  processEvents();
}

void clickButton(QPushButton *button)
{
  const QPointF localPosition(button->rect().center());
  const QPointF globalPosition(button->mapToGlobal(localPosition.toPoint()));
  QMouseEvent press(QEvent::MouseButtonPress, localPosition, globalPosition, Qt::LeftButton, Qt::LeftButton, Qt::NoModifier);
  QMouseEvent release(QEvent::MouseButtonRelease, localPosition, globalPosition, Qt::LeftButton, Qt::NoButton, Qt::NoModifier);
  QApplication::sendEvent(button, &press);
  QApplication::sendEvent(button, &release);
  processEvents();
}

void exerciseSettingsWindow()
{
  showSettingsWindow();
  processEvents();
  auto *dialog = ownerWindow->findChild<QDialog *>("VCMixSettings");
  require(dialog && settingsWindowHealthy(), "Qt settings window did not initialize.");
  require(!dialog->isModal() && !QApplication::activeModalWidget() && ownerWindow->isEnabled(), "Settings blocked OBS's window.");
  require(dialog->styleSheet().isEmpty() && dialog->style() == ownerWindow->style(), "Settings override the host theme.");
  auto *token = control<QLineEdit>(dialog, "vcMixToken");
  token->clear();
  token->setFocus();
  sendKey(token, Qt::Key_X, "x");
  require(token->text() == "x", "Typing did not reach the token field.");
  auto *showToken = control<QCheckBox>(dialog, "vcMixShowToken");
  showToken->click();
  require(token->echoMode() == QLineEdit::Normal, "Show token did not reveal the field.");
  showToken->click();
  require(token->echoMode() == QLineEdit::Password, "Token did not become masked again.");
  token->setFocus();
  sendKey(token, Qt::Key_Tab);
  require(!token->hasFocus() && dialog->isAncestorOf(QApplication::focusWidget()), "Tab did not navigate within settings.");
  auto *save = control<QPushButton>(dialog, "vcMixSave");
  const auto savesBeforeMouse = savedSettings;
  clickButton(save);
  require(savedSettings == savesBeforeMouse + 1, "Mouse did not activate Save settings.");
  save->setFocus();
  sendKey(save, Qt::Key_Return);
  require(savedSettings == savesBeforeMouse + 2, "Enter did not activate the focused button.");
  control<QPushButton>(dialog, "vcMixConnect")->click();
  auto *feedback = control<QLabel>(dialog, "vcMixFeedback");
  require(feedback->isVisible() && feedback->text().contains("bot token"), "Invalid connection settings were not reported inline.");
  require(feedback->textFormat() == Qt::PlainText, "Feedback can interpret untrusted markup.");
  require(!control<QPushButton>(dialog, "vcMixAddSource")->isEnabled(), "An empty participant list enables Add source.");
  dialog->resize(600, 600);
  processEvents();
  for (auto *button : dialog->findChildren<QPushButton *>()) {
    if (!button->isVisible()) continue;
    require(dialog->rect().contains(button->mapTo(dialog, button->rect().bottomRight())), "Resizing clipped a settings action.");
  }
  sendKey(token, Qt::Key_Escape);
  require(!ownerWindow->findChild<QDialog *>("VCMixSettings"), "Escape did not close settings.");
  std::cout << "PASS: Qt theme inheritance, token masking, typing, Tab, mouse, Enter, inline validation, resize and Escape\n";
}

void exerciseOwnerInput()
{
  showSettingsWindow();
  processEvents();
  unsigned ownerClicks = 0;
  unsigned timerTicks = 0;
  QPushButton ownerButton("Owner action", ownerWindow);
  QObject::connect(&ownerButton, &QPushButton::clicked, [&] { ++ownerClicks; });
  QTimer timer;
  QObject::connect(&timer, &QTimer::timeout, [&] { ++timerTicks; });
  timer.start(10);
  clickButton(&ownerButton);
  waitForEvents(50);
  require(ownerClicks == 1 && timerTicks > 0 && ownerWindow->isEnabled(), "Settings blocked the host's input or timers.");
  closeSettingsWindow();
  std::cout << "PASS: Owner input and timers remain responsive while settings are open\n";
}

void exerciseParticipants(const char *helperDirectory)
{
  testReceiver.start(wide(helperDirectory));
  testReceiver.command("test");
  showSettingsWindow();
  auto *dialog = ownerWindow->findChild<QDialog *>("VCMixSettings");
  auto *participants = control<QTreeWidget>(dialog, "vcMixParticipants");
  for (int attempt = 0; attempt < 40 && participants->topLevelItemCount() < 2; ++attempt) waitForEvents(50);
  if (participants->topLevelItemCount() != 2) {
    const auto snapshot = testReceiver.snapshot();
    std::cerr << "Receiver: " << snapshot.status << " / " << snapshot.error << " / " << snapshot.participants.size() << " participants\n";
    throw std::runtime_error("Test participants did not reach the Qt list.");
  }
  participants->setCurrentItem(participants->topLevelItem(1));
  const auto selectedId = participants->currentItem()->data(0, Qt::UserRole).toString();
  waitForEvents(650);
  require(participants->currentItem()->data(0, Qt::UserRole).toString() == selectedId, "Refreshing participants changed selection.");
  require(participants->currentItem()->text(2).toULongLong() > 0, "Participant packet counts did not update.");
  clickButton(control<QPushButton>(dialog, "vcMixAddSource"));
  require(addedUserId == selectedId.toStdString(), "Add source used the wrong participant.");
  testReceiver.command("disconnect");
  for (int attempt = 0; attempt < 40 && participants->topLevelItemCount() > 0; ++attempt) waitForEvents(50);
  require(participants->topLevelItemCount() == 0 && !control<QPushButton>(dialog, "vcMixAddSource")->isEnabled(), "Disconnect left stale participants.");
  closeSettingsWindow();
  testReceiver.stop();
  std::cout << "PASS: Live test participants, stable selection, Add source and disconnect cleanup\n";
}
}

ReceiverBridge &receiver() { return testReceiver; }
ConnectionSettings &connectionSettings() { return testSettings; }
void persistSettings(const ConnectionSettings &settings) { testSettings = settings; ++savedSettings; }
void ensureReceiverRunning() {}
void addParticipantToCurrentScene(const std::string &userId, const std::string &) { addedUserId = userId; }
void *obs_frontend_get_main_window() { return ownerWindow; }

int main(int argc, char **argv)
{
  QApplication application(argc, argv);
  application.setQuitOnLastWindowClosed(false);
  QWidget owner;
  ownerWindow = &owner;
  try {
    require(obs_startup("en-US", nullptr, nullptr), "libobs could not initialize the receiver test environment.");
    exerciseSettingsWindow();
    exerciseSettingsWindow();
    exerciseOwnerInput();
    if (argc > 1) exerciseParticipants(argv[1]);
    obs_shutdown();
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "FAIL: " << error.what() << '\n';
    closeSettingsWindow();
    testReceiver.stop();
    if (obs_initialized()) obs_shutdown();
    return 1;
  }
}
