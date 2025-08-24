#!/bin/bash
# Enhanced VNC startup script for Playwright MCP headful monitoring

echo "Starting VNC services for Playwright MCP headful monitoring..."

# Set default values for display dimensions if not set
export DISPLAY_WIDTH=${DISPLAY_WIDTH:-1600}
export DISPLAY_HEIGHT=${DISPLAY_HEIGHT:-900}

# Kill any existing supervisord processes
pkill -f supervisord 2>/dev/null

# Create logs directory if it doesn't exist
mkdir -p /workspace/logs

# Clean up old log files from the correct location
rm -f /workspace/logs/supervisord.log /workspace/logs/supervisord.pid

# Start supervisord with explicit log and pid file paths
echo "Starting supervisord..."
supervisord -c /vnc-config/supervisord.conf -l /workspace/logs/supervisord.log -j /workspace/logs/supervisord.pid
sleep 2

# Wait for Xvfb to be ready
echo "Waiting for Xvfb display to be ready..."
for i in {1..30}; do
    if DISPLAY=:0.0 xwininfo -root > /dev/null 2>&1; then
        echo "✓ Xvfb display is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "× Xvfb failed to start"
        exit 1
    fi
    sleep 1
done

# Set DISPLAY for the current session
export DISPLAY=:0.0

echo "========================================="
echo "VNC services started successfully!"
echo "========================================="
echo "📺 noVNC Web Interface: http://localhost:8080"
echo "🌐 Chrome DevTools: http://localhost:9222 (when browser is running)"
echo ""
echo "Playwright MCP is configured to run in HEADFUL mode."
echo "You can monitor browser interactions via the noVNC interface."
echo "========================================="