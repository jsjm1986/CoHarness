/* Read the kernel's identity and flags for one opened Btrfs subvolume without a privileged tree search. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/btrfs.h>
#include <linux/magic.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>

static void uuid(const unsigned char *bytes) {
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) putchar('-');
    printf("%02x", (unsigned int)bytes[i]);
  }
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  const int fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 3;
  struct stat st;
  struct statfs fs;
  struct btrfs_ioctl_get_subvol_info_args identity = {0};
  struct btrfs_ioctl_fs_info_args filesystem = {0};
  struct btrfs_ioctl_get_subvol_rootref_args children = {0};
  __u64 flags = 0;
  if (fstat(fd, &st) || fstatfs(fd, &fs)) { perror("subvolume stat"); return 4; }
  if ((unsigned int)fs.f_type != (unsigned int)BTRFS_SUPER_MAGIC || st.st_ino != 256) {
    fputs("not a Btrfs subvolume root\n", stderr); return 4;
  }
  if (ioctl(fd, BTRFS_IOC_GET_SUBVOL_INFO, &identity) < 0) { perror("GET_SUBVOL_INFO"); return 4; }
  if (ioctl(fd, BTRFS_IOC_FS_INFO, &filesystem) < 0) { perror("FS_INFO"); return 4; }
  if (ioctl(fd, BTRFS_IOC_SUBVOL_GETFLAGS, &flags) < 0) { perror("SUBVOL_GETFLAGS"); return 4; }
  if (ioctl(fd, BTRFS_IOC_GET_SUBVOL_ROOTREF, &children) < 0 && (errno != EOVERFLOW || !children.num_items)) {
    perror("GET_SUBVOL_ROOTREF"); return 5;
  }
  uuid(identity.uuid); putchar(' '); uuid(identity.parent_uuid);
  putchar(' '); uuid(filesystem.fsid);
  printf(" %ju %d %d\n", (uintmax_t)st.st_dev, (flags & BTRFS_SUBVOL_RDONLY) != 0, children.num_items != 0);
  return close(fd) ? 6 : 0;
}
