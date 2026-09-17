FROM alpine:3.20
RUN apk add --no-cache bash coreutils
COPY maintain.sh /maintain.sh
RUN chmod +x /maintain.sh
CMD ["/maintain.sh"]
