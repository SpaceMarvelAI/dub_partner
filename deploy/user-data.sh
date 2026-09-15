#!/bin/bash
# EC2 first-boot bootstrap: install and start Docker.
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user
