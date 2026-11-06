# 역방향 실험장의 중계(sshd)와 온프레 터널(ssh) 공용 이미지. 실제 중계는 Amazon Linux EC2, 실제 터널은 차트의 ssh 파드다
FROM alpine:3.20
RUN apk add --no-cache openssh-server openssh-client socat \
 && adduser -D -s /sbin/nologin tunnel \
 && echo 'tunnel:*' | chpasswd -e
COPY relay.sh tunnel.sh /usr/local/bin/
