# Sourced by the host shell in the prepared directory. This code only owns the
# lifetime of its child jobs and terminal. ACP input belongs to the agent.
unset OPENAI_API_KEY
umask 077
acp_provider=
acp_observer=
acp_reported_status=
acp_provider_signalled=
acp_stop_children() {
    acp_signalled=
    [ -n "$!" ] || return 0
    # Run jobs in this shell. dash clears its job table in a command substitution
    # or pipeline. The two descriptors advance independently across snapshots.
    LC_ALL=C jobs -l >&3
    while read -r acp_job acp_pid acp_state acp_next acp_command <&4; do
        case "$acp_job" in '['[0-9]*']'*) ;; *) continue ;; esac
        # dash separates the current/previous-job marker from the job number.
        case "$acp_pid" in '+'|'-') acp_pid=$acp_state; acp_state=$acp_next ;; esac
        # dash drops the wait status after jobs -l lists a finished child.
        if [ "$acp_pid" = "$acp_provider" ]; then
            case "$acp_state" in
                Done) acp_reported_status=0 ;;
                Done\(*\)) acp_code=${acp_state#Done\(}; acp_reported_status=${acp_code%\)} ;;
            esac
        fi
        case "$acp_state" in Running|Stopped|Suspended) ;; *) continue ;; esac
        case "$acp_pid" in ''|*[!0-9]*) continue ;; esac
        # $! covers an interrupt before the launcher assigned the new child PID.
        case "$acp_pid" in "$acp_provider"|"$acp_observer"|"$!")
            if kill -"$1" "$acp_pid" 2>/dev/null; then
                acp_signalled=1
                if [ "$acp_pid" = "$acp_provider" ]; then acp_provider_signalled=1; fi
            fi ;;
        esac
    done
}
acp_finish() {
    acp_status=$1
    trap '' HUP INT TERM USR1
    trap - 0
    acp_stop_children TERM
    if [ -n "$acp_signalled" ]; then
        /bin/sleep 0.1
        acp_stop_children KILL
    fi
    if [ -n "$acp_provider" ]; then
        wait "$acp_provider" 2>/dev/null
        acp_provider_status=$?
        if [ "$acp_provider_status" = 127 ] && [ -n "$acp_reported_status" ]; then
            acp_provider_status=$acp_reported_status
        fi
        if [ "$acp_status" = 0 ] && [ -z "$acp_provider_signalled" ]; then acp_status=$acp_provider_status; fi
    fi
    wait 2>/dev/null || :
    acp_dispose >/dev/null 2>&1
    exit "$acp_status"
}
# Defer interrupts during the atomic ownership claim. A duplicate launch owns
# nothing and must never run the live shell's cleanup.
acp_interrupted=
trap 'acp_interrupted=129' HUP
trap 'acp_interrupted=130' INT
trap 'acp_interrupted=143' TERM
[ -f .acp-jobs ] && [ ! -L .acp-jobs ] || exit 1
exec 3<>.acp-jobs 4<.acp-jobs
acp_activate || exit 1
trap 'acp_finish "$?"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 0' USR1
[ -z "$acp_interrupted" ] || exit "$acp_interrupted"
# Keep LF intact and keep the terminal interrupt available to the host.
if [ -t 1 ]; then /bin/stty -echo -onlcr isig intr '^C' || exit 1; fi
[ -p .acp-in ] && [ ! -L .acp-in ] && [ -p .acp-out ] && [ ! -L .acp-out ] || exit 1
acp_wait() {
    # The observer drains through EOF on provider exit. If the observer itself
    # fails, reclaim the provider immediately even when it is waiting for input.
    wait "$acp_observer"
    acp_status=$?
    acp_observer=
    return "$acp_status"
}
