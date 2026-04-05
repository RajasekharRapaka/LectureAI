# gunicorn.conf.py — Production server config for AWS EC2
import multiprocessing

# Server socket
bind        = "0.0.0.0:5000"
backlog     = 1024

# Workers — (2 × CPU cores) + 1 is the standard formula
workers     = multiprocessing.cpu_count() * 2 + 1
worker_class = "sync"

# Timeout — set high because Gemini 2.5 Pro can take 30-60s on long transcripts
timeout     = 180
keepalive   = 5

# Logging
accesslog   = "-"          # stdout
errorlog    = "-"          # stderr
loglevel    = "info"
access_log_format = '%(h)s "%(r)s" %(s)s %(b)s %(D)sµs'

# Process naming
proc_name   = "tubescribe"

# Limits
max_requests            = 1000   # Restart worker after N requests (prevents memory leaks)
max_requests_jitter     = 50
