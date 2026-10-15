// Page Navigation
document.addEventListener('DOMContentLoaded', function() {
    const navItems = document.querySelectorAll('.nav-item');
    const pages = document.querySelectorAll('.page');
    
    navItems.forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            
            // Update nav
            navItems.forEach(nav => nav.classList.remove('active'));
            this.classList.add('active');
            
            // Update page
            const pageId = 'page-' + this.getAttribute('data-page');
            pages.forEach(page => page.classList.remove('active'));
            const targetPage = document.getElementById(pageId);
            if (targetPage) {
                targetPage.classList.add('active');
            }
        });
    });
    
    // Update time
    function updateTime() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-GB', { 
            hour12: false, 
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit' 
        });
        const timeEl = document.getElementById('currentTime');
        if (timeEl) {
            timeEl.textContent = timeStr;
        }
    }
    updateTime();
    setInterval(updateTime, 1000);
    
    // Fullscreen
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (fullscreenBtn) {
        fullscreenBtn.addEventListener('click', function() {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen();
                this.innerHTML = '<i class="fas fa-compress"></i> Exit full screen';
            } else {
                document.exitFullscreen();
                this.innerHTML = '<i class="fas fa-expand"></i> Full screen';
            }
        });
    }
    
    // Hand mode button
    const handModeBtn = document.getElementById('handModeBtn');
    if (handModeBtn) {
        handModeBtn.addEventListener('click', function() {
            alert('Hand mode activated. Use hand tracking to interact with the dashboard.');
        });
    }
    
    // Terminal quick buttons
    const quickBtns = document.querySelectorAll('.quick-btn');
    quickBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const cmd = this.textContent;
            const outputEl = document.getElementById('terminalOutput');
            if (outputEl) {
                if (cmd === 'clear') {
                    outputEl.innerHTML = '';
                } else {
                    outputEl.innerHTML += cmd + '\n';
                    // Simulate output
                    setTimeout(() => {
                        if (cmd === 'uptime') {
                            outputEl.innerHTML += ' 09:41:36 up 80 days, 19:42, 1 user, load average: 1.15, 1.21, 1.25\n';
                        } else if (cmd === 'free -h') {
                            outputEl.innerHTML += '               total        used        free      shared  buff/cache   available\nMem:          7.0Gi       3.6Gi       2.7Gi       100Mi       0.7Gi       3.3Gi\nSwap:         2.0Gi          0B       2.0Gi\n';
                        } else if (cmd === 'df -h /') {
                            outputEl.innerHTML += 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2   98G   63G   30G  68% /\n';
                        } else if (cmd === 'hermes profiles') {
                            outputEl.innerHTML += 'Profile         Model           Gateway         Alias\n-------------------------------------------------------\ndefault        gpt-5.6-sol     running         -\nresearch        gpt-5.6-sol     stopped         research\nassistant       gpt-5.6-sol     stopped         assistant\n';
                        }
                        outputEl.scrollTop = outputEl.scrollHeight;
                    }, 100);
                }
                outputEl.scrollTop = outputEl.scrollHeight;
            }
        });
    });
    
    // Ask Nexora buttons
    const askBtns = document.querySelectorAll('.ask-nexora-btn');
    askBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            alert('NEXORA is ready. What can I help you with?');
        });
    });
    
    // Agent carousel
    const agentThumbs = document.querySelectorAll('.agent-thumb');
    agentThumbs.forEach(thumb => {
        thumb.addEventListener('click', function() {
            agentThumbs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');
        });
    });
});
