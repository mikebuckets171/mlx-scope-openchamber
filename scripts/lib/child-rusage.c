// Measurement-only wrapper: run one command unchanged, wait4 its exact CPU,
// preserve stdio/exit status, and append bounded private timing metadata.
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
static volatile sig_atomic_t child_pid = -1;
static void forward(int signal_number) { if (child_pid > 0) kill(child_pid, signal_number); }
static long long micros(struct timeval value) { return (long long)value.tv_sec * 1000000 + value.tv_usec; }
int main(int argc, char **argv) {
  if (argc < 3) return 125;
  struct timespec started; clock_gettime(CLOCK_REALTIME, &started);
  sigset_t blocked, original; sigemptyset(&blocked); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGINT); sigaddset(&blocked, SIGHUP); sigprocmask(SIG_BLOCK, &blocked, &original);
  struct sigaction action = {0}; action.sa_handler = forward; sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGHUP, &action, NULL);
  pid_t child = fork(); if (child < 0) return 125;
  if (child == 0) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL);
    sigprocmask(SIG_SETMASK, &original, NULL);
    execvp(argv[2], &argv[2]); _exit(errno == ENOENT ? 127 : 126);
  }
  child_pid = child; sigprocmask(SIG_SETMASK, &original, NULL);
  int status = 0; struct rusage command = {0}, wrapper = {0};
  while (wait4(child, &status, 0, &command) < 0) if (errno != EINTR) return 125;
  struct timespec now; clock_gettime(CLOCK_REALTIME, &now); getrusage(RUSAGE_SELF, &wrapper);
  char record[512];
  int count = snprintf(record, sizeof(record), "{\"kind\":\"child-usage\",\"pid\":%d,\"startedAt\":%lld,\"at\":%lld,\"childCpuMicros\":%lld,\"wrapperCpuMicros\":%lld}\n", (int)getpid(), (long long)started.tv_sec * 1000 + started.tv_nsec / 1000000, (long long)now.tv_sec * 1000 + now.tv_nsec / 1000000, micros(command.ru_utime) + micros(command.ru_stime), micros(wrapper.ru_utime) + micros(wrapper.ru_stime));
  int fd = open(argv[1], O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0600);
  if (fd >= 0) { if (count > 0 && count < (int)sizeof(record)) { ssize_t unused = write(fd, record, (size_t)count); (void)unused; } close(fd); }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) { int signum = WTERMSIG(status); signal(signum, SIG_DFL); raise(signum); return 128 + signum; }
  return 125;
}
